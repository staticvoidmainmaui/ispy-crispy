// ─── POST /chat/stream ─── the same turn, reported as it happens.
//
// Demo 1's bar is "p95 under 8s, streaming so it doesn't feel like 8s". Nothing here
// changes what the answer IS — answerQuestion is the same function /chat calls. The only
// difference is that an onEvent listener is attached, so context lands before the first
// token and each tool reports on start and on finish.
//
// /chat stays byte-identical so the eval harness keeps working.

import { answerQuestion, handleMessage, classifyMessage } from "./handleMessage.mjs";
import {
  serialize, contextFrame, toolStartFrame, toolEndFrame,
  textFrame, proposalFrame, doneFrame, errorFrame, runFrame,
} from "../run/events.mjs";

// ─── streamMessage(req, res, { message, userId, ctx }) ───
export async function streamMessage(res, { message, userId, ctx = {} }) {
  const startedAt = Date.now();

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    // nginx and friends buffer event streams into uselessness without this.
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();

  const counts = { hits: 0, tools: 0, proposals: 0 };
  let runId = null;
  let skipped = null;

  const send = (frame) => res.write(serialize(frame));

  // ─── event -> frame ───  the only place the two vocabularies meet.
  const onEvent = (event) => {
    switch (event.type) {
      case "run":
        runId = event.runId;
        return send(runFrame(event.runId, event.userId, event.startedAt));

      case "context":
        counts.hits = event.hits.length;
        return send(contextFrame(runId, event.hits.map(h => ({
          rank: h.rank, kind: h.kind, id: h.id, content: h.content,
          memory_type: h.memory_type, tags: h.tags,
          distance: h.distance, relevance: h.relevance,
          recency: h.recency, frequency: h.frequency, score: h.score,
        }))));

      case "tool_start":
        return send(toolStartFrame(runId, {
          seq: event.seq, iteration: event.iteration, name: event.name, input: event.input,
        }));

      case "tool_end": {
        counts.tools += 1;
        // search_signals is the one tool whose SKIP COUNT belongs in the summary — it is
        // the number that makes the filtering believable.
        if (event.ok && typeof event.output?.skipped === "number") skipped = event.output.skipped;
        const { type, ...call } = event;   // drop the internal discriminator
        return send(toolEndFrame(runId, call));
      }

      case "text":
        return send(textFrame(runId, event.delta));

      case "proposal":
        counts.proposals += 1;
        return send(proposalFrame(runId, {
          id: event.id, action: event.action, payload: event.payload,
          rationale: event.rationale, status: event.status,
        }));

      case "error":
        return send(errorFrame(runId, event.domain, event.message));

      default:
        return undefined;
    }
  };

  try {
    const intent = await classifyMessage(message);

    if (intent !== "question") {
      // A write is not a chain — there is nothing to stream. Emit the confirmation as one
      // text frame so the client still has exactly one code path.
      const reply = await handleMessage(message, userId, null, null, ctx, intent);
      send(textFrame(null, reply));
    } else {
      await answerQuestion({ userMessage: message, userId, ctx, intent, onEvent });
    }

    send(doneFrame(runId, {
      status: "ok",
      latencyMs: Date.now() - startedAt,
      counts: { ...counts, ...(skipped === null ? {} : { skipped }) },
    }));
  } catch (err) {
    // answerQuestion already emitted a domain-labeled error frame for the failures it
    // knows about; this is the catch-all so the stream always terminates cleanly.
    console.error("streamMessage(): turn failed:", err);
    send(errorFrame(runId, "TURN", err.message));
    send(doneFrame(runId, { status: "error", latencyMs: Date.now() - startedAt, counts }));
  } finally {
    res.end();
  }
}
