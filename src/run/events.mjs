// ─── The run event protocol ─── one vocabulary, two producers.
//
// Live turns emit these frames as they happen; GET /runs/:id/events rebuilds the SAME
// frames from the ledger. 
// Frames are STATE DELTAS, can populate while the model is still thinking. 
// Renderers are a pure function of the state, and the client can keep a single reducer for all events.

export const PROTOCOL_VERSION = 1;

// ─── frame(type, payload) → { event, data } ───
// `v` on every frame so a shipped client can refuse a protocol it doesn't know.
function frame(event, data) {
  return { event, data: { v: PROTOCOL_VERSION, ...data } };
}

export const runFrame      = (runId, userId, startedAt) => frame("run", { runId, userId, startedAt });
export const contextFrame  = (runId, hits)              => frame("context", { runId, hits });
export const toolStartFrame= (runId, call)              => frame("tool_start", { runId, ...call });
export const toolEndFrame  = (runId, call)              => frame("tool_end", { runId, ...call });
export const textFrame     = (runId, delta)             => frame("text", { runId, delta });
export const proposalFrame = (runId, proposal)          => frame("proposal", { runId, ...proposal });
export const doneFrame     = (runId, summary)           => frame("done", { runId, ...summary });

// A tool failure is a tool_end with ok:false, NOT an error frame — degradation has to stay
// visible without ending the stream. `error` is reserved for the turn itself dying.
export const errorFrame    = (runId, domain, message)   => frame("error", { runId, domain, message });

// ─── serialize(frame) → SSE wire format ───
// Blank line terminates the frame; without it the client buffers forever.
export function serialize({ event, data }) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
