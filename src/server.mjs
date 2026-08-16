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

  try {
    const trace = {};
    const reply = await handleMessage(message, userId, debug ? trace : null, created_at);
    return res.json(debug ? { reply, hits: trace.hits ?? [] } : { reply });
  }
  catch (error) {
    console.error("Error in /chat route:  OR EMPTY REPLY ???", error);
    return res.status(500).json({ error: "Internal server error - handleMessage failed" });
  }
});

app.listen(PORT, () => console.log(`Go Gators listening on http://localhost:${PORT}`));
