// Go Gators — Phase 3 HTTP boundary.
// The adapter that exposes handleMessage() over HTTP. Thin on purpose:
// parse the request -> call handleMessage -> serialize the reply.
// Business logic (recall, LLM call) lives in handleMessage, NOT here.
//
// Run:  node --env-file=.env src/server.mjs
// Test: curl -s localhost:3000/chat -H "content-type: application/json" \
//         -d '{"userId":"maui","message":"what do I have this week?"}'

import express from "express";
import { handleMessage } from "./chat/handleMessage.mjs";
import { streamMessage } from "./chat/streamMessage.mjs";
import { listActions, decideAction, replayRun } from "./run/ledger.mjs";
import { authorize, validate, receive } from "./ingest/receive.mjs";
import { serialize } from "./run/events.mjs";
import { pool } from "./db/pool.mjs";
//Dev user test
import { DEV_USER } from "./config.mjs";

const app = express();
app.use(express.json()); // parse JSON request bodies into req.body

//mauimir:
//req.body is a propperty of the request object that contains the 
// parsed body of the incoming request.
//its a object with a response body as well which is the parsed body of the incoming request.
//how does it contain message and userId? because the request body is a JSON object with those properties, and express.json() middleware parses it into req.body.

const PORT = process.env.PORT ?? 3000; //use env PORT or default to 3000

// ─── GET /health — liveness ──────────────────────────────────────────────────
app.get("/health", (_req, res) => res.json({ status: "ok" }));

// ─── GET /ready — readiness ──────────────────────────────────────────────────
app.get("/ready", async (_req, res) => {
  try {
    await pool.query("select 1");
    return res.json({ status: "ready", db: "ok" });
  } catch (err) {
    return res.status(503).json({ status: "degraded", db: err.message });
  }
});

// ─── POST /chat ──────────────────────────────────────────────────────────────
// The one route that drives the whole read path.
// Pull `message` and `userId` out of req.body. -> Validate them. -> Call handleMessage(message, userId) -> Respond with the reply.
app.post("/chat", async (req, res) => {
  
  const { message, userId= DEV_USER, created_at = null } = req.body; //created_at: eval-only backdate for seeding recency tests

  if (!message ) {
    return res.status(400).json({ error: "Missing message" });
  }
  if (!userId) {
    return res.status(400).json({ error: "Missing userId" });
  }

  // eval-only debug side-channel: ?debug=1 exposes the recalled memory set (`hits`)
  // alongside the reply. Off by default, so the production response is unchanged.
  const debug = req.query.debug === "1";

  // Deterministic tool failure for the eval. debug=1 only.
  const ctx = debug ? { forceFail: req.get("x-tools-force-fail") ?? null } : {};

  try {
    const trace = {};
    const reply = await handleMessage(message, userId, debug ? trace : null, created_at, ctx);
    // `tools` = which tools ran, with what arguments.
    return res.json(debug
      ? { reply, hits: trace.hits ?? [], tools: trace.tools ?? [], runId: trace.runId ?? null }
      : { reply });
  }
  catch (error) {
    console.error("Error in /chat route:  OR EMPTY REPLY ???", error);
    return res.status(500).json({ error: "Internal server error - handleMessage failed" });
  }
});

// ─── POST /chat/stream ───────────────────────────────────────────────────────
// Same turn as /chat, reported as it happens. /chat is untouched so the eval keeps working.
app.post("/chat/stream", async (req, res) => {
  const { message, userId = DEV_USER } = req.body;

  if (!message) return res.status(400).json({ error: "Missing message" });
  if (!userId)  return res.status(400).json({ error: "Missing userId" });

  // Headers are written inside streamMessage, so nothing after this may res.json().
  await streamMessage(res, { message, userId, ctx: {} });
});

// ─── GET /runs/:id/events ────────────────────────────────────────────────────
// Replay. Same frames, same order, so a client reducer can't tell it from a live turn.
app.get("/runs/:id/events", async (req, res) => {
  const userId = req.query.userId ?? DEV_USER;

  try {
    const frames = await replayRun(req.params.id, userId);
    if (!frames) return res.status(404).json({ error: "run not found" });

    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    for (const frame of frames) res.write(serialize(frame));
    return res.end();
  } catch (err) {
    console.error("GET /runs/:id/events failed:", err);
    return res.status(500).json({ error: "replay failed" });
  }
});

// ─── GET /actions ────────────────────────────────────────────────────────────
// The proof of "0 writes pending approval": a list, and a count that isn't a screenshot.
app.get("/actions", async (req, res) => {
  const userId = req.query.userId ?? DEV_USER;
  const status = req.query.status ?? null;
  const runId  = req.query.runId ?? null;

  try {
    const actions = await listActions(userId, { status, runId });
    return res.json({ actions, count: actions.length });
  } catch (err) {
    console.error("GET /actions failed:", err);
    return res.status(500).json({ error: "could not list actions" });
  }
});

// ─── POST /actions/:id/approve | /reject ─────────────────────────────────────
// The ONLY path in the system that writes calendar_events.
for (const decision of ["approve", "reject"]) {
  app.post(`/actions/:id/${decision}`, async (req, res) => {
    const userId = req.body?.userId ?? req.query.userId ?? DEV_USER;

    try {
      const result = await decideAction(req.params.id, userId, decision);

      if (result.status === "not_found")      return res.status(404).json({ error: "action not found" });
      if (result.status === "expired")        return res.status(410).json({ error: "action expired" });
      if (result.status === "already_decided") {
        return res.status(409).json({ error: "already decided", status: result.action.status });
      }
      return res.json(result);
    } catch (err) {
      console.error(`POST /actions/:id/${decision} failed:`, err);
      return res.status(500).json({ error: "could not decide action" });
    }
  });
}

// ─── POST /ingest/:kind ──────────────────────────────────────────────────────
// The whole external-data surface. n8n / LangChain POST here; nothing in this repo fetches.
app.post("/ingest/:kind", async (req, res) => {
  const denied = authorize(req);
  if (denied) return res.status(401).json({ error: denied });

  const parsed = validate(req.params.kind, req.body);
  if (parsed.error) return res.status(400).json({ error: parsed.error });

  try {
    const counts = await receive(req.params.kind, parsed.userId, parsed.items);
    return res.json({ kind: req.params.kind, ...counts });
  } catch (err) {
    console.error(`POST /ingest/${req.params.kind} failed:`, err);
    return res.status(500).json({ error: "ingest failed" });
  }
});

app.listen(PORT, () => console.log(`Go Gators listening on http://localhost:${PORT}`));
