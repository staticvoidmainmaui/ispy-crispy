// ReflectAgent — maintenance on the store, between conversations. Five phases:
//   expire     lapse working memories
//   contradict supersede overturned beliefs
//   merge      collapse restatement clusters into one summary
//   tag        assign facets for cheap filtered retrieval
//   promote    bump importance for frequently-recalled memories
//
// Order matters: expire shrinks later candidate sets, merge follows contradict,
// tag follows merge, promote reads access_count last.

import Anthropic from "@anthropic-ai/sdk";
import {
  findContradictionCandidates, markSuperseded,
  findMergeClusters, markConsolidated,
  expireWorking, findUntagged, setTags, promoteHot,
} from "../memory/consolidation.mjs";
import { writeMemory } from "../memory/writeMemory.mjs";

const anthropic = new Anthropic();

const JUDGE_MODEL = "claude-haiku-4-5";
const MAX_PAIRS = 20;
const TAG_BATCH_SIZE = 20;

// Distance thresholds live in consolidation.mjs, not here.

export const PHASES = ["expire", "contradict", "merge", "tag", "promote"];

// ── Controlled tag vocabulary ────────────────────────────────────────────────
// Closed set: an open vocabulary yields food/cuisine/eating for one concept and
// the `tags && $1` filter in 08 then matches nothing.
export const TAG_VOCAB = [
  "scheduling", "preference", "location", "food", "health",
  "work", "social", "routine", "travel",
];

const VERDICT_SCHEMA = { //verdict object
  type: "object",
  properties: { verdict: { type: "string", enum: ["contradicts", "compatible"] } },
  required: ["verdict"],
  additionalProperties: false,
};

const SUMMARY_SCHEMA = { //summary object
  type: "object",
  properties: {
    summary: { type: "string" },
    tags: { type: "array", items: { type: "string", enum: TAG_VOCAB } },
  },
  required: ["summary", "tags"],
  additionalProperties: false,
};

const TAG_SCHEMA = {  //tagging object ? distinct ?
  type: "object",
  properties: {
    assignments: {
      type: "array",
      items: {
        type: "object",
        properties: {
          index: { type: "integer" },
          tags: { type: "array", items: { type: "string", enum: TAG_VOCAB } },
        },
        required: ["index", "tags"],
        additionalProperties: false,
      },
    },
  },
  required: ["assignments"],
  additionalProperties: false,
};

// ── judgeContradiction ───────────────────────────────────────────────────────
// The real filter — distance can't separate contradiction from unrelated, so this
// gets handed unrelated pairs on purpose.

//logic to be evaluated after lexical matching
async function judgeContradiction(older, newer) {
  const system =
    "You decide whether a newer statement CONTRADICTS an older one.\n\n" +
    "contradicts = both describe the SAME attribute of the same subject, and the values " +
    "cannot both be true. Example: \"I prefer mornings\" then \"I prefer afternoons now\".\n\n" +
    "compatible = anything else. Specifically, ALL of these are compatible:\n" +
    "  - a restatement or rephrasing of the same fact\n" +
    "  - an addition or elaboration that does not overturn the older statement\n" +
    "  - two statements about different attributes, even if the wording is similar\n" +
    "  - two unrelated statements that merely share a phrase (\"I hate mornings\" / \"I hate laundry\")\n\n" +
    "A restatement is NOT a contradiction. When unsure, answer compatible: a wrong " +
    "\"contradicts\" destroys a memory the user still relies on, while a wrong " +
    "\"compatible\" only leaves a duplicate for a later pass.";

  try {
    const result = await anthropic.messages.create({
      model: JUDGE_MODEL,
      max_tokens: 100,
      system,
      messages: [{ role: "user", content: `OLDER: ${older}\nNEWER: ${newer}` }],
      output_config: { format: { type: "json_schema", schema: VERDICT_SCHEMA } },
    });

    const { verdict } = JSON.parse(result.content[0].text);
    return verdict === "contradicts" ? "contradicts" : "compatible";
  } catch (judgeError) {
    // Fail toward the cheap mistake: a missed contradiction beats a destroyed memory.
    console.error("judgeContradiction(): failed, defaulting to compatible:", judgeError.message);
    return "compatible";
  }
}

// ── summarizeCluster ─────────────────────────────────────────────────────────
// ? what if members are distinctly different? The model is instructed to preserve every detail
async function summarizeCluster(members) {
  const system =
    "You merge several memories that all express the SAME underlying fact about one person " +
    "into a single statement.\n\n" +
    "Rules:\n" +
    "  - Write in the person's own voice, first person, one or two sentences.\n" +
    "  - Preserve every distinct detail. If members disagree on a detail, prefer the " +
    "specific over the vague, and never invent a reconciliation.\n" +
    "  - Do NOT add anything the members don't say.\n" +
    "  - Then pick the tags from the allowed list that describe the merged statement.";

  const numbered = members.map((m, i) => `${i + 1}. ${m.content}`).join("\n");

  const result = await anthropic.messages.create({
    model: JUDGE_MODEL,
    max_tokens: 300,
    system,
    messages: [{ role: "user", content: `MEMORIES:\n${numbered}` }],
    output_config: { format: { type: "json_schema", schema: SUMMARY_SCHEMA } },
  });

  return JSON.parse(result.content[0].text); // { summary, tags }
}

// ── tagBatch ─────────────────────────────────────────────────────────────────
// Batched, and keyed by INDEX not uuid — a mistyped uuid would tag the wrong row.
async function tagBatch(rows) {
  const system =
    "Assign facet tags to each memory, choosing only from the allowed list.\n" +
    "Pick every tag that genuinely applies, usually one or two. If none apply, return an " +
    "empty array for that memory rather than forcing a poor fit.\n" +
    "Return one entry per memory, using the index shown.";

  const numbered = rows.map((r, i) => `${i}. ${r.content}`).join("\n"); // [1. r.content, 2. r.content, etc.]

  const result = await anthropic.messages.create({
    model: JUDGE_MODEL,
    max_tokens: 1000,
    system,
    messages: [{ role: "user", content: `MEMORIES:\n${numbered}` }],
    output_config: { format: { type: "json_schema", schema: TAG_SCHEMA } },
  });

  const { assignments } = JSON.parse(result.content[0].text);

  // Map index -> row, dropping anything out of range rather than trusting the model.
  return assignments
    .filter(a => Number.isInteger(a.index) && a.index >= 0 && a.index < rows.length)
    .map(a => ({ id: rows[a.index].id, content: rows[a.index].content, tags: a.tags }));
}

// ── reflect ──────────────────────────────────────────────────────────────────
// Per-phase report. A phase that throws records { error } and the run continues.
// dryRun writes nothing, but merge still summarizes so you can read the proposal.
export async function reflect(userId, {
  dryRun = false,
  phases = PHASES,
  maxDistance,      // contradiction gate; undefined = consolidation.mjs default
  mergeDistance,    // restatement gate;  undefined = consolidation.mjs default
  limit = MAX_PAIRS,
  ttlHours = 24,
  minAccess = 5,
  tagLimit = 100,
} = {}) {
  if (!userId) throw new Error("reflect(): requires a userId.");

  const report = { userId, dryRun, phases: {} };
  const run = async (name, fn) => {
    if (!phases.includes(name)) return;
    try {
      report.phases[name] = await fn();
    } catch (phaseError) {
      console.error(`reflect(): phase "${name}" failed:`, phaseError.message);
      report.phases[name] = { error: phaseError.message };
    }
  };

  // ── Phase 1: expire ──
  await run("expire", async () => {
    if (dryRun) {
      return { backfilled: 0, note: "dry run — no expiry written" };
    }
    const rows = await expireWorking(userId, { ttlHours });
    return { backfilled: rows.length };
  });

  // ── Phase 2: contradict ──
  await run("contradict", async () => {
    const candidates = await findContradictionCandidates(userId, { maxDistance, limit });
    // Sequential: each judgement is a billed call; 20 at once invites a rate limit.
    const decisions = [];
    for (const pair of candidates) {
      const verdict = await judgeContradiction(pair.older, pair.newer);
      let superseded = false;
      if (verdict === "contradicts" && !dryRun) {
        superseded = Boolean(await markSuperseded(pair.older_id, pair.newer_id));
      }
      decisions.push({
        olderId: pair.older_id, older: pair.older,
        newerId: pair.newer_id, newer: pair.newer,
        distance: pair.distance, verdict, superseded,
      });
    }
    return {
      examined: candidates.length,
      superseded: decisions.filter(d => d.superseded).length,
      decisions,
    };
  });

  // ── Phase 3: merge ──
  await run("merge", async () => {
    const clusters = await findMergeClusters(userId, { maxDistance: mergeDistance });
    const details = [];
    let written = 0, membersMarked = 0;

    for (const members of clusters) {
      let summary;
      try {
        summary = await summarizeCluster(members);
      } catch (summarizeError) {
        // Skip the cluster — never strand members pointing at a summary that failed.
        console.error("reflect(): summarizeCluster failed, skipping cluster:", summarizeError.message);
        details.push({ size: members.length, error: summarizeError.message });
        continue;
      }

      if (dryRun) {
        details.push({ size: members.length, summary: summary.summary, tags: summary.tags, wrote: false });
        continue;
      }

      // Summary first — members point at its id, so a failure leaves the store intact.
      const row = await writeMemory(summary.summary, {
        userId,
        memoryType: "consolidated",
        importance: "high",
        tags: summary.tags,
        metadata: { consolidated_from: members.map(m => m.id) },
      });

      if (!row) {   // dedup hit — nothing to point members at
        details.push({ size: members.length, summary: summary.summary, wrote: false, note: "duplicate summary" });
        continue;
      }

      written++;
      let marked = 0;
      for (const member of members) {
        if (await markConsolidated(member.id, row.id)) marked++;
      }
      membersMarked += marked;
      details.push({ size: members.length, summary: summary.summary, tags: summary.tags, summaryId: row.id, marked, wrote: true });
    }

    return { clusters: clusters.length, written, membersMarked, details };
  });

  // ── Phase 4: tag ──
  await run("tag", async () => {
    const rows = await findUntagged(userId, { limit: tagLimit });
    if (rows.length === 0) return { examined: 0, updated: 0, assignments: [] };

    const assignments = [];
    for (let i = 0; i < rows.length; i += TAG_BATCH_SIZE) {
      const batch = rows.slice(i, i + TAG_BATCH_SIZE);
      assignments.push(...await tagBatch(batch));
    }

    if (dryRun) {
      return { examined: rows.length, updated: 0, assignments };
    }

    let updated = 0;
    for (const a of assignments) {
      if (await setTags(a.id, a.tags)) updated++;
    }
    return { examined: rows.length, updated, assignments };
  });

  // ── Phase 5: promote ──
  await run("promote", async () => {
    if (dryRun) {
      // No preview: promote_hot.sql selects and updates in one statement.
      return { promoted: 0, note: "dry run — no promotion written" };
    }
    const rows = await promoteHot(userId, { minAccess });
    return { promoted: rows.length, rows };
  });

  return report;
}
