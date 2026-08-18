// ─── The reducer ─── frames in, state out. No DOM, no fetch, no timers.
//
// This is the seam the contract (ui-contract.html §03) exists to protect: a browser
// client and an Electron shell can only stay in sync if BOTH derive their screen from
// this object and nothing else. `phase` in particular is derived only from frames —
// never from a button handler or a callback, or the two clients diverge on exactly
// the states that are hardest to reproduce.

export const PROTOCOL_VERSION = 1;

export class ProtocolError extends Error {
  constructor(v) {
    super(`unsupported protocol version: ${v}`);
    this.name = "ProtocolError";
    this.version = v;
  }
}

// ─── initialState() ───
export function initialState() {
  return {
    protocol:   PROTOCOL_VERSION,
    runId:      null,
    userId:     null,
    startedAt:  null,
    replay:     false,

    phase:      "idle",   // idle | recalling | working | answering | done | failed | dropped

    hits:       [],
    hitsLoaded: false,    // distinguishes "none matched" from "not yet"

    tools:      {},       // keyed by seq — NOT an array; ends arrive out of band
    text:       "",
    proposals:  [],
    summary:    null,
    error:      null,     // { domain, message } — first one wins
  };
}

const warned = new Set();
const warnOnce = (key, msg) => { if (!warned.has(key)) { warned.add(key); console.warn(msg); } };

// ─── apply(state, frame) → state ───
// `frame` is { event, data } — the same shape replay and the live wire both produce.
export function apply(state, { event, data }) {
  // 1. Version gate, before anything else. Never best-effort a shape you don't know.
  if (data?.v !== PROTOCOL_VERSION) throw new ProtocolError(data?.v);

  switch (event) {
    // Reset wholesale. A second `run` is a NEW turn, not an update.
    case "run":
      return {
        ...initialState(),
        runId:     data.runId,
        userId:    data.userId,
        startedAt: data.startedAt,
        phase:     "recalling",
      };

    // Replace, never merge. hitsLoaded goes true even when the array is empty.
    case "context":
      return { ...state, hits: data.hits ?? [], hitsLoaded: true, phase: "working" };

    case "tool_start":
      return {
        ...state,
        phase: state.phase === "answering" ? "answering" : "working",
        tools: {
          ...state.tools,
          [data.seq]: {
            seq: data.seq, iteration: data.iteration, name: data.name,
            input: data.input, state: "running",
            ms: null, output: null, error: null,
          },
        },
      };

    // Merges into an existing entry. NEVER creates one — an unknown seq means a
    // dropped frame, which is worth knowing about in dev.
    case "tool_end": {
      const prior = state.tools[data.seq];
      if (!prior) {
        warnOnce(`seq:${data.seq}`, `tool_end for unknown seq ${data.seq} — a frame was dropped`);
        return state;
      }
      return {
        ...state,
        tools: {
          ...state.tools,
          [data.seq]: {
            ...prior,
            state:  data.ok ? "ok" : "failed",
            ms:     data.ms ?? null,
            output: data.output ?? null,
            error:  data.error ?? null,
          },
        },
      };
    }

    // Append verbatim. Whitespace is part of the token.
    case "text":
      return { ...state, text: state.text + data.delta, phase: "answering" };

    // Dedupe on id so a replay after a live run doesn't double up.
    case "proposal": {
      if (state.proposals.some(p => p.id === data.id)) return state;
      const { v, runId, ...proposal } = data;
      return { ...state, proposals: [...state.proposals, proposal] };
    }

    case "done":
      return {
        ...state,
        summary: { status: data.status, latencyMs: data.latencyMs, counts: data.counts ?? {} },
        replay:  data.replay === true,
        phase:   data.status === "error" ? "failed" : "done",
      };

    // First, most specific one wins. Does NOT set phase — `done` does.
    case "error":
      if (state.error) return state;
      return { ...state, error: { domain: data.domain, message: data.message } };

    // Unknown event: ignore and continue. Never break a stream over a frame the
    // server added after this client shipped.
    default:
      warnOnce(`event:${event}`, `unknown frame "${event}" — ignored`);
      return state;
  }
}

// ─── markDropped(state) ───
// Not a frame. Called by the transport when the stream closed with no `done`, or
// when a tool_start was never paired. Distinct from `failed`: the turn may well have
// finished server-side, so the offer is "reload this run", not "something broke".
export function markDropped(state) {
  if (state.phase === "done" || state.phase === "failed" || state.phase === "idle") return state;
  return { ...state, phase: "dropped" };
}

// ─── derived helpers ─── pure, used by render only.

export function toolList(state) {
  return Object.values(state.tools).sort((a, b) => a.seq - b.seq);
}

// Tools sharing an `iteration` ran concurrently — group them so that reads as parallel.
export function toolIterations(state) {
  const groups = new Map();
  for (const t of toolList(state)) {
    if (!groups.has(t.iteration)) groups.set(t.iteration, []);
    groups.get(t.iteration).push(t);
  }
  return [...groups.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([iteration, tools]) => ({ iteration, tools }));
}

export const hasUnpairedTool = (state) => toolList(state).some(t => t.state === "running");

// The write path emits no run and no context: one text frame with runId null.
export const isWritePath = (state) =>
  state.runId === null && (state.text.length > 0 || state.summary !== null);
