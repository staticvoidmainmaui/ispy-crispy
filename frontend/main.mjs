// ─── wiring ─── the only file that knows both a transport and the DOM exist.
//
// Everything below the fold is: get frames from somewhere → apply → render. Swapping
// the fixture replay for the live server is a one-line change in runTurn().

import { initialState, apply, markDropped, ProtocolError } from "./reducer.mjs";
import { render, renderGate } from "./render.mjs";
import { replayFixture, streamTurn } from "./transport.mjs";

// Set to true once the backend is up. It flips the composer and the proposal
// buttons from inert to live; nothing else changes.
const LIVE = false;
const USER_ID = "00000000-0000-0000-0000-000000000001";

const dom = {
  shell:       document.getElementById("shell"),
  led:         document.getElementById("led"),
  phaseLabel:  document.getElementById("phase-label"),
  usage:       document.getElementById("usage"),
  fixtures:    document.getElementById("fixtures"),
  col:         document.getElementById("col"),
  chatScroll:  document.getElementById("chat-scroll"),
  railBody:    document.getElementById("rail-body"),
  railCount:   document.getElementById("rail-count"),
};

let state    = initialState();
let fixture  = null;          // { meta, frames }
let current  = null;          // fixture filename
let abort    = null;

const handlers = {
  live: LIVE,
  get prompt() { return fixture?.meta?.prompt ?? null; },
  get currentFixture() { return current; },
  onPrompt: (q) => { if (LIVE) runLive(q); },
  onDecide: (id, decision) => decide(id, decision),
  onReload: (runId) => reload(runId),
};

const draw = () => render(state, dom, handlers);

// ─── feed(frame) ─── the single entry point for every frame, live or replayed.
function feed(frame) {
  try {
    state = apply(state, frame);
  } catch (err) {
    if (err instanceof ProtocolError) { renderGate(document.body, err.version); throw err; }
    throw err;
  }
  draw();
}

// ─── runTurn ─── SWAP POINT.
//   fixture mode:  replayFixture(fixture.frames, feed, { delay })
//   live mode:     streamTurn(message, USER_ID, feed)
async function runTurn({ frames, delay = 0 }) {
  abort?.abort();
  abort = new AbortController();
  state = initialState();
  draw();

  let outcome;
  try {
    outcome = await replayFixture(frames, feed, { delay, signal: abort.signal });
  } catch {
    return;  // aborted by a newer run
  }

  // `dropped` is derived here, not from a frame — the stream closing with no `done`
  // is exactly the thing no frame can tell you.
  if (outcome === "dropped") { state = markDropped(state); draw(); }
  dom.chatScroll.scrollTop = dom.chatScroll.scrollHeight;
}

async function runLive(message) {
  abort?.abort();
  abort = new AbortController();
  state = initialState();
  draw();
  try {
    const outcome = await streamTurn(message, USER_ID, feed, { signal: abort.signal });
    if (outcome === "dropped") { state = markDropped(state); draw(); }
  } catch (err) {
    console.error("stream failed:", err);
    state = markDropped(state);
    draw();
  }
}

// ─── proposal decisions ─── the only path that can write calendar_events.
// Deliberately NOT optimistic: POST, then re-read. A card that flips before the
// server agreed is the exact lie this whole design exists to avoid.
async function decide(id, decision) {
  if (!LIVE) return;
  const res = await fetch(`/actions/${id}/${decision}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId: USER_ID }),
  });
  if (!res.ok) { console.error("decide failed:", res.status, await res.text()); return; }
  const { action } = await res.json();
  state = { ...state, proposals: state.proposals.map(p => p.id === id ? { ...p, status: action.status } : p) };
  draw();
}

// ─── reload a dropped run ─── same frames, same reducer.
async function reload(runId) {
  if (!LIVE || !runId) return;
  const res = await fetch(`/runs/${runId}/events?userId=${USER_ID}`);
  if (!res.ok) { console.error("replay failed:", res.status); return; }
  const text = await res.text();
  state = initialState();
  for (const chunk of text.split("\n\n")) {
    const ev = /^event:\s*(.+)$/m.exec(chunk);
    const dt = /^data:\s*(.+)$/m.exec(chunk);
    if (ev && dt) feed({ event: ev[1].trim(), data: JSON.parse(dt[1]) });
  }
}

// ─── fixture picker ───
async function loadFixture(file, { delay = 0 } = {}) {
  current = file;
  fixture = await (await fetch(`./fixtures/${file}`)).json();
  await runTurn({ frames: fixture.frames, delay });
  draw();  // repaint the picker's pressed state
}

async function boot() {
  const { fixtures } = await (await fetch("./fixtures/manifest.json")).json();

  dom.fixtures.replaceChildren();
  for (const f of fixtures) {
    const b = document.createElement("button");
    b.type = "button";
    b.dataset.file = f.file;
    b.setAttribute("aria-pressed", "false");
    const glyph = document.createElement("span");
    glyph.textContent = "○";
    const body = document.createElement("span");
    body.append(f.label);
    const note = document.createElement("span");
    note.className = "fx-note";
    note.textContent = `${f.phase} · ${f.note}`;
    body.append(note);
    b.append(glyph, body);
    b.addEventListener("click", () => loadFixture(f.file));
    dom.fixtures.append(b);
  }

  document.getElementById("replay").addEventListener("click", () => {
    if (current) loadFixture(current, { delay: 220 });
  });

  document.getElementById("theme").addEventListener("click", () => {
    const root = document.documentElement;
    root.dataset.theme = root.dataset.theme === "light" ? "dark" : "light";
  });

  const input = document.getElementById("composer-input");
  input.disabled = !LIVE;
  input.placeholder = LIVE ? "write a message" : "write a message  ·  fixture mode, not wired";
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && input.value.trim()) { runLive(input.value.trim()); input.value = ""; }
  });

  draw();
  await loadFixture(fixtures[0].file);
}

boot();
