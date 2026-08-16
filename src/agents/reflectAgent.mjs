// ReflectAgent — runs between conversations. Finds near-duplicate semantic memories,
// asks whether the newer one contradicts the older, supersedes the loser.

import Anthropic from "@anthropic-ai/sdk";
import { findContradictionCandidates, markSuperseded } from "../memory/consolidation.mjs";

const anthropic = new Anthropic();

const JUDGE_MODEL = "claude-haiku-4-5";
const MAX_DISTANCE = 0.85;
const MAX_PAIRS = 20;

const VERDICT_SCHEMA = {
  type: "object",
  properties: { verdict: { type: "string", enum: ["contradicts", "compatible"] } },
  required: ["verdict"],
  additionalProperties: false,
};

// ── judgeContradiction ───────────────────────────────────────────────────────
async function judgeContradiction(older, newer) {
  // TODO 1: write the system prompt. It must draw one line:
  //   contradicts  = same attribute, incompatible values ("mornings" then "afternoons")
  //   compatible   = a rephrasing, an addition, or a different attribute entirely
  //   Say explicitly that a restatement is NOT a contradiction — that's the false positive
  //   that would destroy good memories.
  const system = "Does the newer statement contradict the older one about the same attribute? " +
          "Rephrasings and additions are NOT contradictions.";

  try {
    const result = await anthropic.messages.create({
      model: JUDGE_MODEL,
      max_tokens: 100,
      system,
      messages: [{
        role: "user",
        content: `OLDER: ${older}\nNEWER: ${newer}` }],
      output_config: {
        format: { type: "json_schema", schema: VERDICT_SCHEMA }
      },
    });

    const { verdict } = JSON.parse(result.content[0].text);
    return verdict === "contradicts" ? "contradicts" : "compatible";
  } catch (ConsolidationError) {
    console.error("judgeContradiction(): failed, defaulting to compatible:", ConsolidationError.message);
    return "compatible";
  }
}

// ── reflect ──────────────────────────────────────────────────────────────────
export async function reflect(userId, { dryRun = false, maxDistance = MAX_DISTANCE, limit = MAX_PAIRS } = {}) {
  const candidates = await findContradictionCandidates(userId, { maxDistance, limit });
  //   Judging is independent per pair — consider Promise.all, but note each is a billed
  //   call and 20 at once may rate-limit. Sequential is fine at this volume.
  const decisions = [];
  for (const pair of candidates) {
    const verdict = await judgeContradiction(pair.older , pair.newer);

    let superseded = false;

    if(verdict === "contradicts" && !dryRun) {
      superseded = Boolean(await markSuperseded(pair.older_id, pair.newer_id));
    }
    decisions.push({
      olderId: pair.older_id,
      older: pair.older,
      newerId: pair.newer_id,
      newer: pair.newer,
      distance: pair.distance,
      verdict,
      superseded,
    });
  }
  //return summary of the reflection process
  return {
    userId,
    examined: candidates.length,
    superseded: decisions.filter(d => d.superseded).length,
    decisions
  };
  // decisions.filter(d => d.superseded).map(d => `${d.older} superseded ${d.newer}`).join(", ");
}
