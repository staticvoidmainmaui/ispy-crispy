// ─── The agent run ledger ─── the write side of 17.
//
// Timing is the whole design here. A turn that pays for its own audit trail on the user's
// clock is a turn that misses p95, so:
//   - startRun    is ONE insert, before the first LLM call (SSE needs the id immediately)
//   - proposeAction is synchronous — the reply text names the proposal, so it must be durable
//   - finishRun   writes tool_calls + context_hits + the terminal status in ONE transaction,
//                 AFTER the response has finished streaming

import { pool, withTransaction } from "../db/pool.mjs";
import { loadSql, sqlDir } from "../db/sql.mjs";
import { updateCalendarEvent, createCalendarEvent, renderContent } from "../entities/calendarEvents.mjs";
import { getEmbedding } from "../memory/embeddings.mjs";
import {
  runFrame, contextFrame, toolStartFrame, toolEndFrame, proposalFrame, doneFrame,
} from "./events.mjs";

const SQL = sqlDir(import.meta.url);

// ─── startRun({ userId, userMessage, intent, model }) → { id, startedAt } ───
export async function startRun({ userId, userMessage, intent = null, model = null }) {
  const { rows } = await pool.query(loadSql(SQL, "start_run"),
    [userId, userMessage, intent, model]);
  return rows[0];
}

// ─── finishRun(runId, { ... }) → void ───
// Never throws at the caller: the turn already succeeded from the user's point of view,
// and losing the audit row is not worth turning a good answer into a 500.
export async function finishRun(runId, {
  status = "ok", latencyMs = null, tokensIn = null, tokensOut = null,
  error = null, intent = null, toolCalls = [], hits = [],
} = {}) {
  if (!runId) return;

  try {
    await withTransaction(async (client) => {
      if (toolCalls.length > 0) {
        await client.query(loadSql(SQL, "insert_tool_calls"),
          [runId, JSON.stringify(toolCalls)]);
      }
      if (hits.length > 0) {
        await client.query(loadSql(SQL, "insert_context_hits"),
          [runId, JSON.stringify(hits)]);
      }
      await client.query(loadSql(SQL, "finish_run"),
        [runId, status, latencyMs, tokensIn, tokensOut, error, intent]);
    });
  } catch (ledgerError) {
    console.error("finishRun(): ledger write failed (non-fatal):", ledgerError.message);
  }
}

// ─── proposeAction({ ... }) → the pending row ───
export async function proposeAction({
  runId, userId, action, targetKind = null, targetId = null,
  payload = {}, rationale = null,
}) {
  const { rows } = await pool.query(loadSql(SQL, "insert_proposed_action"),
    [runId, userId, action, targetKind, targetId, JSON.stringify(payload), rationale]);
  return rows[0];
}

// ─── listActions(userId, { status, runId, limit }) → rows ───
export async function listActions(userId, { status = null, runId = null, limit = 50 } = {}) {
  const { rows } = await pool.query(loadSql(SQL, "list_actions"),
    [userId, status, runId, limit]);
  return rows;
}

// ─── decideAction(id, userId, decision) → { status, event? } ───
// THE ONLY PATH THAT WRITES calendar_events. Everything else in the system can propose;
// only a human calling this can commit.
//
// The embedding is computed BEFORE the transaction opens — a Bedrock round trip inside
// BEGIN holds a connection and a lock for ~80ms of pure network.
export async function decideAction(id, userId, decision) {
  if (decision !== "approve" && decision !== "reject") {
    throw new Error(`decideAction(): unknown decision "${decision}"`);
  }

  // Step 1 — read the proposal unlocked, only to learn whether we need an embedding.
  const preview = await pool.query(loadSql(SQL, "read_action"), [id, userId]);
  const proposal = preview.rows[0];
  if (!proposal) return { status: "not_found" };
  if (proposal.status !== "pending") return { status: "already_decided", action: proposal };

  let embedding = null;
  let content = null;
  if (decision === "approve" && needsContent(proposal)) {
    content = renderContent({
      title: proposal.payload.title,
      startsAt: proposal.payload.starts_at,
      location: proposal.payload.location,
    });
    embedding = await getEmbedding(content);
  }

  // Step 2 — the atomic unit: claim, apply, mark. One transaction, no compensations.
  return withTransaction(async (client) => {
    const { rows } = await client.query(loadSql(SQL, "lock_action"), [id, userId]);
    const locked = rows[0];
    if (!locked) return { status: "not_found" };
    if (locked.status !== "pending") return { status: "already_decided", action: locked };
    if (locked.expires_at && new Date(locked.expires_at) < new Date()) {
      await client.query(loadSql(SQL, "decide_action"), [id, "expired", false]);
      return { status: "expired" };
    }

    if (decision === "reject") {
      await client.query(loadSql(SQL, "decide_action"), [id, "rejected", false]);
      return { status: "rejected" };
    }

    const event = await applyAction(client, locked, { content, embedding });
    await client.query(loadSql(SQL, "decide_action"), [id, "applied", true]);
    return { status: "applied", event };
  });
}

// `create_event` and `move_event` change what the row SAYS, so the embedding must change
// with it. `cancel_event` only flips status — content is unaffected.
function needsContent(proposal) {
  return proposal.action === "create_event" || proposal.action === "move_event";
}

// ─── applyAction(client, proposal, { content, embedding }) → the mutated row ───
// Every branch takes `client`: the calendar write and the status flip are one unit, so a
// failure between them is impossible rather than compensated.
async function applyAction(client, proposal, { content, embedding }) {
  const p = proposal.payload ?? {};

  switch (proposal.action) {
    case "create_event":
      return createCalendarEvent({
        userId: proposal.user_id,
        title: p.title,
        startsAt: p.starts_at,
        endsAt: p.ends_at ?? null,
        location: p.location ?? null,
        placeLat: p.place_lat ?? null,
        placeLon: p.place_lon ?? null,
        source: "proposal",
        metadata: { proposed_by: proposal.run_id, proposal_id: proposal.id },
        content, embedding, client,   // embedded before BEGIN, inserted inside it
      });

    case "move_event":
      return updateCalendarEvent(proposal.target_id, proposal.user_id, {
        content, embedding,
        startsAt: p.starts_at ?? null,
        endsAt: p.ends_at ?? null,
        location: p.location ?? null,
        placeLat: p.place_lat ?? null,
        placeLon: p.place_lon ?? null,
      }, client);

    case "cancel_event":
      return updateCalendarEvent(proposal.target_id, proposal.user_id,
        { status: "cancelled" }, client);

    case "open_cart":
      // Demo 4's bar is "nothing purchased, cart link only". Approving is an
      // acknowledgement, not a transaction — there is deliberately nothing to apply.
      return null;

    default:
      throw new Error(`applyAction(): unknown action "${proposal.action}"`);
  }
}

// ─── replayRun(runId, userId) → frames[] ───
// Rebuilds the live stream from the ledger. Same constructors, same order, so the client
// reducer cannot tell a replay from a live turn.
export async function replayRun(runId, userId) {
  const { rows } = await pool.query(loadSql(SQL, "load_run"), [runId, userId]);
  if (rows.length === 0 || !rows[0].run) return null;

  const { run, hits, tools, proposals } = rows[0];
  const frames = [runFrame(run.id, run.user_id, run.started_at)];

  if (hits.length > 0) {
    frames.push(contextFrame(run.id, hits.map(h => ({
      rank: h.rank, kind: h.kind, id: h.entity_id,
      distance: h.distance, relevance: h.relevance,
      recency: h.recency, frequency: h.frequency, score: h.score,
    }))));
  }

  for (const t of tools) {
    frames.push(toolStartFrame(run.id, {
      seq: t.seq, iteration: t.iteration, name: t.tool_name, input: t.input,
    }));
    frames.push(toolEndFrame(run.id, {
      seq: t.seq, ok: t.ok, ms: t.latency_ms,
      ...(t.ok ? { output: t.output } : { error: t.error }),
    }));
  }

  for (const p of proposals) {
    frames.push(proposalFrame(run.id, {
      id: p.id, action: p.action, payload: p.payload,
      rationale: p.rationale, status: p.status,
    }));
  }

  // No `text` frames: the ledger stores the turn's shape, not its prose. A replay shows
  // WHAT happened and WHY it ranked — which is the pane that matters.
  frames.push(doneFrame(run.id, {
    status: run.status,
    latencyMs: run.latency_ms,
    counts: { hits: hits.length, tools: tools.length, proposals: proposals.length },
    replay: true,
  }));

  return frames;
}
