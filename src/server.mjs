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

// ─── POST /chat ──────────────────────────────────────────────────────────────
// The one route that drives the whole read path.
app.post("/chat", async (req, res) => {
  // TODO (yours — this is the meaningful part):
  //   1. Pull `message` and `userId` out of req.body.
  
  //   2. VALIDATE: what makes a request unusable? (missing message? missing userId?)
  //      Decide what a bad request looks like and respond 400 with a clear reason.
  //      Trade-off: strict validation = clearer errors but more rejections;
  //      lenient = fewer 400s but garbage can reach the LLM (and cost you tokens).
  //   3. Call handleMessage(message, userId), await the reply.
  //   4. Respond with res.json({ reply }).

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


  //
  //   Note: handleMessage currently SWALLOWS errors (catch -> returns undefined).
  //   So decide: do you trust it to always return a string, or guard for undefined
  //   here and return a 500? That's a real design choice about where errors surface.
});

app.listen(PORT, () => console.log(`Go Gators listening on http://localhost:${PORT}`));
