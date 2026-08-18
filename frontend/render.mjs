// ─── render(state) → DOM ─── a pure function of the reducer's state.
//
// No component here reads a frame, and no frame handler touches the DOM. Full
// re-render on every change: the state is small, and the alternative is two clients
// diverging on incremental-update bugs nobody can reproduce.

import { toolIterations, hasUnpairedTool, isWritePath } from "./reducer.mjs";

const KINDS = ["memory", "calendar_event", "task", "signal", "offer"];

// A human sentence per tool, so the feed reads like the reference shots rather than
// like a stack trace. Keyed by the EXACT registry names (src/tools/registry.mjs).
const LABEL = {
  geocode_place:           "Finding where that is",
  get_weather:             "Checking conditions there",
  get_forecast:            "Checking the weather before ordering the day",
  get_calendar:            "Reading your calendar",
  travel_time:             "Checking you can actually get there",
  propose_calendar_change: "Drafting a change for your approval",
  search_signals:          "Filtering what happened against your memories",
  search_offers:           "Searching against your remembered preferences",
  recall_more:             "Going back to memory for a detail",
};

// Plain words for the user; `message` is for the console, never the screen.
const DOMAIN = {
  RETRIEVAL:  "Couldn't reach the memory store.",
  GENERATION: "The model didn't finish the answer.",
  TURN:       "The turn failed.",
};

// ─── el(tag, attrs, ...children) ───
function el(tag, attrs = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? "" : String(v));
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    node.append(typeof kid === "string" ? document.createTextNode(kid) : kid);
  }
  return node;
}

const fmtMs = (ms) => (ms === null ? "" : ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`);
const clock = (iso) => { try { return new Date(iso).toISOString().slice(11, 16); } catch { return iso; } };

// Measured Titan bands (docs + memory), NOT a generic 0-1 ramp. Against a generic
// ramp every real match looks bad.
function band(distance) {
  if (distance <= 0.10) return "restatement";
  if (distance >= 0.66) return "unrelated";
  if (distance >= 0.36) return "contradiction";
  return "between";
}

// ─── render(state, dom, handlers) ───
export function render(state, dom, handlers = {}) {
  renderSidebar(state, dom, handlers);
  renderChat(state, dom, handlers);
  renderRail(state, dom);

  // The write path has no run and no context. A skeleton that never fills reads as
  // a bug, so the rail is removed outright rather than emptied.
  dom.shell.dataset.rail = (state.phase === "idle" || isWritePath(state)) ? "off" : "on";
}

// ══ SIDEBAR ══
function renderSidebar(state, dom, handlers) {
  dom.led.dataset.phase = state.phase;
  dom.phaseLabel.textContent = state.phase;

  const c = state.summary?.counts ?? {};
  dom.usage.replaceChildren(
    el("h4", { text: "this run" }),
    el("dl", {},
      el("dt", { text: "hits" }),      el("dd", { text: String(state.hits.length) }),
      el("dt", { text: "tools" }),     el("dd", { text: String(Object.keys(state.tools).length) }),
      el("dt", { text: "proposals" }), el("dd", { text: String(state.proposals.length) }),
      el("dt", { text: "skipped" }),
      el("dd", { class: c.skipped === undefined ? "dim" : "", text: c.skipped === undefined ? "—" : String(c.skipped) }),
      el("dt", { text: "latency" }),
      el("dd", { class: state.summary ? "" : "dim", text: state.summary ? fmtMs(state.summary.latencyMs) : "—" }),
      el("dt", { text: "protocol" }),  el("dd", { class: "dim", text: `v${state.protocol}` }),
    ),
  );

  dom.fixtures.querySelectorAll("button").forEach((b) => {
    b.setAttribute("aria-pressed", String(b.dataset.file === handlers.currentFixture));
  });
}

// ══ CHAT COLUMN ══
function renderChat(state, dom, handlers) {
  const out = [];

  if (state.phase === "idle") {
    out.push(hero(handlers));
  } else {
    if (handlers.prompt) {
      out.push(el("p", { class: "you" }, el("b", { text: ">" }), el("span", { text: handlers.prompt })));
    }
    const feed = statusFeed(state);
    if (feed) out.push(feed);
    if (state.text) out.push(answer(state));
    for (const p of state.proposals) out.push(proposalCard(p, state, handlers));
    const b = banner(state, handlers);
    if (b) out.push(b);
    const t = tally(state);
    if (t) out.push(t);
  }

  dom.col.replaceChildren(...out);
}

function hero(handlers) {
  return el("section", { class: "hero" },
    el("h1", {}, "hello, alejandro.", el("span", { class: "cur" })),
    el("p", { text: "ask, and watch which memory answers." }),
    el("div", { class: "chips" },
      ...["Plan my day tomorrow.", "What's on this week?", "Find me running shoes."].map((q) =>
        el("button", { text: q, onclick: () => handlers.onPrompt?.(q) })),
    ),
  );
}

// ─── the status feed ───
function statusFeed(state) {
  const groups = toolIterations(state);
  if (!state.hitsLoaded && !groups.length) return null;

  const rows = [];

  // The recall row comes first because retrieval always does — and its skip count is
  // the number that makes the filtering believable.
  if (state.hitsLoaded) {
    const skipped = state.summary?.counts?.skipped;
    rows.push(row({
      state: "ok", glyph: "✓", name: "recalled",
      label: state.hits.length ? "Reading what you've told me" : "Nothing in memory bore on this",
      meta: [`${state.hits.length} hit${state.hits.length === 1 ? "" : "s"}`,
             skipped === undefined ? null : `${skipped} skipped`].filter(Boolean).join(" · "),
      sub: state.hits.slice(0, 3).map((h) => ({ text: h.content })),
    }));
  } else if (state.phase === "recalling") {
    rows.push(row({ state: "running", glyph: "▸", name: "recalling", label: "Searching your memory", meta: "" }));
  }

  for (const { iteration, tools } of groups) {
    rows.push(el("div", { class: "iter" },
      el("span", {}, "iteration ", el("b", { text: String(iteration) })),
      tools.length > 1 ? el("span", { text: `${tools.length} in parallel` }) : null,
    ));
    for (const t of tools) rows.push(toolRow(t));
  }

  return el("div", { class: "feed" }, ...rows);
}

function toolRow(t) {
  const glyph = t.state === "ok" ? "✓" : t.state === "failed" ? "✗" : "▸";
  return row({
    state: t.state,
    glyph,
    name: t.name,
    label: LABEL[t.name] ?? "",
    meta: t.state === "running" ? "running" : fmtMs(t.ms),
    sub: toolSub(t),
  });
}

// Sub-lines are where the proof lives: an argument the user never typed came out of
// memory. Say so explicitly rather than hoping it is noticed.
function toolSub(t) {
  const out = [];

  for (const [k, v] of Object.entries(t.input ?? {})) {
    if (v === null || v === undefined) continue;
    const val = typeof v === "object" ? JSON.stringify(v) : String(v);
    out.push({ text: `${k}: ${val}`, cls: k === "place" || k === "query" ? "from-mem" : null });
  }

  if (t.state === "failed") out.push({ text: t.error, cls: "err" });

  if (t.state === "ok" && t.output) {
    if (Array.isArray(t.output)) {
      for (const item of t.output.slice(0, 4)) {
        out.push({ text: item.starts_at ? `${clock(item.starts_at)}  ${item.title}` : summarize(item) });
      }
    } else if (typeof t.output === "object") {
      if (typeof t.output.skipped === "number") {
        out.push({ text: `${t.output.considered} considered, ${t.output.skipped} skipped at gate ${t.output.gate}` });
        for (const item of t.output.items ?? []) out.push({ text: item.content });
      } else {
        out.push({ text: summarize(t.output) });
      }
    }
  }
  return out;
}

const summarize = (o) =>
  Object.entries(o).slice(0, 4).map(([k, v]) => `${k}: ${typeof v === "object" ? "…" : v}`).join("  ");

function row({ state, glyph, name, label, meta, sub = [] }) {
  return el("div", { class: `row ${state}` },
    el("div", { class: "line" },
      el("span", { class: "g", text: glyph }),
      el("span", {}, el("span", { class: "nm", text: name }), label ? el("span", { class: "lbl", text: "  " + label }) : null),
      el("span", { class: "meta", text: meta ?? "" }),
    ),
    sub.length ? el("div", { class: "sub" }, ...sub.map((s) => el("span", { class: s.cls ?? "", text: s.text }))) : null,
  );
}

function answer(state) {
  return el("div", { class: "answer" },
    state.text,
    state.phase === "answering" ? el("span", { class: "cur" }) : null,
  );
}

// ─── proposal ─── the wording is "pending", never past tense. Nothing is written
// until POST /actions/:id/approve, which is the only path that can write.
function proposalCard(p, state, handlers) {
  const pending = p.status === "pending";
  const live = Boolean(handlers.live);

  return el("article", { class: "proposal" },
    el("header", {},
      el("span", { text: pending ? "PENDING YOUR APPROVAL" : `${p.status.toUpperCase()}` }),
      el("span", { class: "act", text: p.action }),
    ),
    el("div", { class: "body" },
      el("div", { class: "ttl", text: p.payload?.title ?? p.action }),
      el("div", { class: "diff" }, ...diffLines(p)),
      p.rationale ? el("p", { class: "why", text: p.rationale }) : null,
      pending
        ? el("div", { class: "acts" },
            el("button", { class: "yes", text: "✓ approve", disabled: !live,
                           onclick: () => handlers.onDecide?.(p.id, "approve") }),
            el("button", { class: "no", text: "✗ reject", disabled: !live,
                           onclick: () => handlers.onDecide?.(p.id, "reject") }),
            live ? null : el("small", { text: "fixture mode — no server to post to" }),
          )
        : el("p", { class: "decided", text: `already ${p.status} — read only` }),
    ),
  );
}

function diffLines(p) {
  const keys = [...new Set([...Object.keys(p.before ?? {}), ...Object.keys(p.payload ?? {})])];
  const lines = [];
  for (const k of keys) {
    const was = p.before?.[k];
    const now = p.payload?.[k];
    if (was !== undefined && was !== now) lines.push(el("span", { class: "del", text: `- ${k}: ${fmtVal(was)}` }));
    if (now !== undefined && was !== now) lines.push(el("span", { class: "add", text: `+ ${k}: ${fmtVal(now)}` }));
  }
  if (!lines.length) {
    for (const [k, v] of Object.entries(p.payload ?? {})) lines.push(el("span", { class: "add", text: `+ ${k}: ${fmtVal(v)}` }));
  }
  return lines;
}

const fmtVal = (v) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v) ? `${v.slice(0, 10)} ${clock(v)}` : String(v));

function banner(state, handlers) {
  if (state.phase === "failed") {
    if (state.error) console.error("[run]", state.error.domain, state.error.message);
    return el("div", { class: "banner err" },
      el("b", { text: DOMAIN[state.error?.domain] ?? "The turn failed." }),
      el("p", { text: "Anything already written above still stands. The details are in the console." }),
    );
  }
  if (state.phase === "dropped") {
    return el("div", { class: "banner warn" },
      el("b", { text: "Stream ended without a done frame." }),
      el("p", { text: hasUnpairedTool(state)
        ? "A tool started and never reported back. The turn may well have finished on the server."
        : "The connection dropped. The turn may well have finished on the server." }),
      el("button", { text: "reload this run", onclick: () => handlers.onReload?.(state.runId) }),
    );
  }
  return null;
}

function tally(state) {
  if (!state.summary) return null;
  const c = state.summary.counts ?? {};
  const parts = [
    el("b", { text: `${c.hits ?? state.hits.length} shown` }),
  ];
  if (c.skipped !== undefined) parts.push(el("span", { text: "·" }), el("b", { class: "skip", text: `${c.skipped} skipped` }));
  parts.push(el("span", { text: "·" }), el("b", { text: `${c.tools ?? 0} tools` }));
  if (c.proposals) parts.push(el("span", { text: "·" }), el("b", { text: `${c.proposals} pending` }));
  parts.push(el("span", { text: "·" }), el("b", { text: fmtMs(state.summary.latencyMs) }));
  if (state.replay) parts.push(el("span", { text: "·" }), el("b", { text: "replay" }));
  return el("div", { class: "tally" }, ...parts);
}

// ══ CONTEXT RAIL ══
function renderRail(state, dom) {
  dom.railCount.textContent = state.hitsLoaded ? `${state.hits.length}` : "";

  if (!state.hitsLoaded) {
    // Retrieval never returned and never will. A skeleton that outlives the turn
    // reads as a hung UI, so say what actually happened instead.
    if (state.phase === "failed" || state.phase === "dropped") {
      dom.railBody.replaceChildren(el("p", { class: "empty", text: "Retrieval never returned — nothing reached the prompt." }));
      return;
    }
    // Skeleton sized to 3 hits. Not animated — retrieval is usually under 200ms and
    // an animation just flashes.
    dom.railBody.replaceChildren(...Array.from({ length: 3 }, () =>
      el("div", { class: "skel" }, el("i", {}), el("i", {}), el("i", {}))));
    return;
  }

  if (!state.hits.length) {
    // A real, correct outcome: the model got a bare system prompt. Never a spinner.
    dom.railBody.replaceChildren(el("p", { class: "empty", text: "No memories matched this question." }));
    return;
  }

  // score can exceed 1.0 (weights sum to 1.2), so the bar is scaled to the max in
  // THIS set and the figure is printed raw. Never a percentage.
  const max = Math.max(...state.hits.map((h) => h.score));
  dom.railBody.replaceChildren(...state.hits.map((h) => hitRow(h, max)));
}

function hitRow(h, max) {
  const kind = KINDS.includes(h.kind) ? h.kind : "memory";
  const b = band(h.distance);

  return el("article", { class: "hit" },
    el("div", { class: "top" },
      el("span", { class: "dot", style: `background: var(--k-${kind})` }),
      el("span", { class: "kind", text: h.kind.replace("_", " ") }),
      h.memory_type ? el("span", { class: "mt", text: h.memory_type }) : null,
      el("span", { class: "sc", text: h.score.toFixed(3) }),
    ),
    el("div", { class: "sbar" }, el("i", { style: `width:${Math.max(2, (h.score / max) * 100)}%; background: var(--k-${kind})` })),
    el("p", { class: "content", text: h.content }),
    h.tags?.length ? el("div", { class: "tags" }, ...h.tags.map((t) => el("span", { text: t }))) : null,
    el("details", {},
      el("summary", { text: "scores" }),
      el("dl", {},
        el("dt", { text: "distance" }),  el("dd", { text: h.distance.toFixed(3) }),  el("span", { class: "band", "data-band": b, text: b }),
        el("dt", { text: "relevance" }), el("dd", { text: h.relevance.toFixed(3) }), el("span", { class: "band", "data-band": "between", text: "relative" }),
        el("dt", { text: "recency" }),   el("dd", { text: h.recency.toFixed(3) }),   el("span", {}),
        el("dt", { text: "frequency" }), el("dd", { text: h.frequency.toFixed(3) }), el("span", {}),
      ),
      el("p", { class: "rel-note", text: "relevance is normalized within this query — rank 0 is always 1.000. distance is the absolute measure." }),
    ),
  );
}

// ─── the version gate ─── a full stop, not a degraded render.
export function renderGate(root, version) {
  root.replaceChildren(el("div", { class: "gate" },
    el("div", {},
      el("b", { text: "THIS CLIENT IS OUT OF DATE" }),
      el("p", { text: `The server is speaking protocol v${version}; this client only knows v1.` }),
    ),
  ));
}
