// ReflectAgent — runs between conversations, as maintenance on the store.
//
// It used to do one thing: find near-duplicate semantic memories and supersede the
// contradicted one. That is now the second of five phases. The claim this upgrade makes
// is bigger than "chatbot with RAG" — a background agent that REORGANIZES the store:
//
//   expire     lapse working memories so scratch doesn't accumulate forever
//   contradict supersede beliefs a newer statement overturned      (the original job)
//   merge      collapse clusters of restatements into one summary
//   tag        assign facets so retrieval can filter cheaply
//   promote    bump importance for memories recalled often enough to prove they matter
//
// Order is deliberate and each phase feeds the next:
//   expire runs FIRST because it shrinks every candidate set that follows.
//   merge runs after contradict so a superseded row is never folded into a summary.
//   tag runs after merge so we never spend an LLM call tagging a row about to be hidden.
//   promote runs LAST because it reads access_count, which nothing above it changes.

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

// Thresholds are NOT redefined here. They live in consolidation.mjs next to the
// measurements that justify them — this file used to carry a MAX_DISTANCE of 0.85 that
// silently disagreed with consolidation's 0.25, and the caller always won.

export const PHASES = ["expire", "contradict", "merge", "tag", "promote"];

// ── Controlled tag vocabulary ────────────────────────────────────────────────
// Closed set, not open-ended. Faceted retrieval needs tags that MATCH each other: an
// open vocabulary yields "food", "cuisine", "eating", "meals" for one concept and the
// `tags && $1` filter in 08 then finds nothing. A small controlled set is what makes
// the facet cheap and meaningful. Grow it deliberately, never by letting the model invent.
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
// The measured distance bands for contradiction (0.36–0.76) and unrelated (0.66–0.92)
// OVERLAP, so the candidate query cannot pre-filter cleanly. This judge is the actual
// filter, and it will be handed unrelated pairs on purpose. Saying "compatible" to
// those is the correct outcome, not a miss.

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
    // Fail toward the cheap mistake (pattern #4): a skipped contradiction is a duplicate
    // that survives to the next run; a wrongly-supersed memory is gone from every answer.
    console.error("judgeContradiction(): failed, defaulting to compatible:", judgeError.message);
    return "compatible";
  }
}

// ── summarizeCluster ─────────────────────────────────────────────────────────
// Several ways of saying one thing -> one consolidated memory that says it once.

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
// One call per batch of rows, not one per row — tagging the whole store one memory at
// a time is the kind of per-row LLM call that makes a nightly job expensive.
//
// Assignments come back keyed by INDEX, never by uuid. A model asked to echo a uuid
// will occasionally mistype one, and a mistyped uuid either writes tags to the wrong
// memory or silently no-ops. An integer index can only be right or out of range.
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
// Returns a per-phase report. Every phase is its own labeled failure domain
// (pattern #3): one phase throwing records an error and the run continues, because a
// tagging outage is no reason to skip promotion.
//
// dryRun computes what each phase WOULD do and writes nothing. The merge phase still
// calls the summarizer on a dry run — the proposed summary text is the whole point of
// previewing a merge, and seeing it is how you decide the threshold is right.
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

  // ── Phase 1: expire ── shrink everything downstream before it runs.
  await run("expire", async () => {
    if (dryRun) {
      // Nothing to preview beyond a count; the backfill is unconditional.
      return { backfilled: 0, note: "dry run — no expiry written" };
    }
    const rows = await expireWorking(userId, { ttlHours });
    return { backfilled: rows.length };
  });

  // ── Phase 2: contradict ── the original job.
  await run("contradict", async () => {
    const candidates = await findContradictionCandidates(userId, { maxDistance, limit });
    // Sequential on purpose: each judgement is a billed call and firing 20 at once
    // invites a rate limit. At this volume the latency is irrelevant — it's a batch job.
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

  // ── Phase 3: merge ── collapse restatements into one consolidated memory.
  await run("merge", async () => {
    const clusters = await findMergeClusters(userId, { maxDistance: mergeDistance });
    const details = [];
    let written = 0, membersMarked = 0;

    for (const members of clusters) {
      let summary;
      try {
        summary = await summarizeCluster(members);
      } catch (summarizeError) {
        // Skip this cluster, leave its members untouched. A failed summary must never
        // strand members pointing at a summary that was never written.
        console.error("reflect(): summarizeCluster failed, skipping cluster:", summarizeError.message);
        details.push({ size: members.length, error: summarizeError.message });
        continue;
      }

      if (dryRun) {
        details.push({ size: members.length, summary: summary.summary, tags: summary.tags, wrote: false });
        continue;
      }

      // Write the summary FIRST. Its id is what members point at, so a failure here
      // leaves the store exactly as it was rather than half-merged.
      const row = await writeMemory(summary.summary, {
        userId,
        memoryType: "consolidated",   // explicit: never rely on inference for a synthetic row
        importance: "high",           // it speaks for several memories, so it outranks any one
        tags: summary.tags,
        metadata: { consolidated_from: members.map(m => m.id) },
      });

      if (!row) {
        // Dedup hit — this exact summary already exists. Nothing to point members at.
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

  // ── Phase 4: tag ── facets for cheap filtered retrieval.
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

  // ── Phase 5: promote ── reward memories that keep proving useful.
  await run("promote", async () => {
    if (dryRun) {
      // No preview query today: promote_hot.sql both selects and updates in one
      // statement. Seeing the would-promote set needs its own SELECT — worth adding
      // when the numbers get tuned, not before.
      return { promoted: 0, note: "dry run — no promotion written" };
    }
    const rows = await promoteHot(userId, { minAccess });
    return { promoted: rows.length, rows };
  });

  return report;
}
