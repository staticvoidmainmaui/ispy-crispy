// ─── /ingest/:kind ─── the whole external-data surface.
//
// No GitHub client, no RSS parser, no Gmail code lives in this repo. n8n or a LangChain
// job owns fetching and normalising; it POSTs one uniform envelope here. Adding a source
// is a workflow, not a deploy.
//
// It also makes the demos testable: a fixture POST seeds a deterministic digest without
// mocking anyone's API.

import { ingestSignals } from "../entities/signals.mjs";
import { ingestTasks } from "../entities/tasks.mjs";
import { ingestOffers } from "../entities/offers.mjs";

const HANDLERS = Object.freeze({
  signal: ingestSignals,
  task:   ingestTasks,
  offer:  ingestOffers,
});

const MAX_ITEMS = 200;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── authorize(req) → null | reason ───
// Unset INGEST_TOKEN closes the endpoint rather than opening it. An ingest route that is
// public by default is a way to write into someone else's memory.
export function authorize(req) {
  const expected = process.env.INGEST_TOKEN;
  if (!expected) return "ingest is not configured (INGEST_TOKEN unset)";

  const header = req.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (token !== expected) return "bad or missing bearer token";

  return null;
}

// ─── validate(kind, body) → { error } | { userId, items } ───
export function validate(kind, body) {
  if (!HANDLERS[kind]) {
    return { error: `unknown kind "${kind}" — expected one of ${Object.keys(HANDLERS).join(", ")}` };
  }

  const { userId, items } = body ?? {};

  // userId is a uuid column; a bad one fails quietly on write and silently on recall.
  if (typeof userId !== "string" || !UUID_RE.test(userId)) {
    return { error: "userId must be a UUID" };
  }
  if (!Array.isArray(items) || items.length === 0) {
    return { error: "items must be a non-empty array" };
  }
  if (items.length > MAX_ITEMS) {
    return { error: `items exceeded ${MAX_ITEMS} per request` };
  }

  for (const [i, item] of items.entries()) {
    if (typeof item?.content !== "string" || item.content.trim().length === 0) {
      return { error: `items[${i}].content must be a non-empty string` };
    }
    // `content` is the ONLY thing embedded, so it is the only field with a hard contract.
    if (kind === "signal" && (!item.source || !item.external_id)) {
      return { error: `items[${i}] needs source and external_id for idempotent re-ingest` };
    }
    if (kind === "offer" && !item.external_id) {
      return { error: `items[${i}] needs external_id for idempotent re-ingest` };
    }
  }

  return { userId, items };
}

// ─── receive(kind, userId, items) → counts ───
export async function receive(kind, userId, items) {
  return HANDLERS[kind](userId, items);
}
