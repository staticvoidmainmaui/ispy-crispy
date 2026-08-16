// Phase 1 — Embed-on-write (typed).
// The "write half" of the RAG loop: text in -> embed -> INSERT a TYPED row.
// This is your personal/writeMemory_P.mjs, grown up: it now sets memory_type,
// importance, and user_id so the row is useful for Scale B, not just a text dump.

import { createClient } from "@supabase/supabase-js";
import { getEmbedding } from "./embeddings.mjs";
import { pool, toVectorLiteral} from "../db/pool.mjs"


// ─────────────────────────────────────────────────────────────────────────────
// THE CLASSIFICATION DECISION — episodic vs semantic.
//   • episodic = a thing that happened / will happen  ("dentist appt Friday 3pm")
//   • semantic = a durable preference or fact          ("prefers morning study blocks"
// ─────────────────────────────────────────────────────────────────────────────
function similarity(a, b) {
  const dot  = a.reduce((sum, val, i) => sum + val * b[i], 0);
  const magA = Math.sqrt(a.reduce((sum, val) => sum + val * val, 0));
  const magB = Math.sqrt(b.reduce((sum, val) => sum + val * val, 0));
  return dot / (magA * magB);
}

// ------------------- OPTIMAL DESIGN: type is decided by the CALLER ---------------
//
// The best design choice here is architectural, not algorithmic. In the real planner
// loop the memory's type is KNOWN by where the write comes from:
//   • event-creation path  -> writeMemory(text, { memoryType: "episodic" })   (calendar fact)
//   • preference-extraction -> writeMemory(text, { memoryType: "semantic" })  (learned fact)

 let prototypes;

    async function getPrototypes() {
      if (!prototypes) {
        prototypes = {
          semantic: await getEmbedding("a lasting personal preference or habit i tend to have"),
          episodic: await getEmbedding("an appointment or event happening at a specific date or time"),
        };
      }
      return prototypes;
    }
const VALID_TYPES = new Set(["episodic", "semantic", "procedural", "working", "consolidated"]);
const CLASSIFY_MARGIN = 0.05; // fallback only: semantic must clearly beat episodic to win

async function inferMemoryType(embedding) {
  const semScore = similarity(embedding, SEMANTIC_PROTOTYPE);
  const epiScore = similarity(embedding, EPISODIC_PROTOTYPE);
  return semScore - epiScore > CLASSIFY_MARGIN ? "semantic" : "episodic";
}

export async function writeMemory(content, { userId, memoryType, importance = "medium", id, createdAt } = {}) {

  if (!userId) throw new Error("writeMemory needs a userId (per-user isolation).");
  if (memoryType && !VALID_TYPES.has(memoryType)) {
    throw new Error(`invalid memoryType "${memoryType}"`);
  }

  // --- Embed
  const embedding = await getEmbedding(content);

  // --- Authoritative if the caller passed it; inferred only as a last resort.
  const type = memoryType ?? inferMemoryType(embedding);

  // --- Upsert - converted from .upsert function into the raw INSERT ... on CONFLICT it translates to 
  //upsert: to branch out to something on a collision rather than crashing on conflict insert
  const { rows } = await pool.query(
    `insert into memories (id, user_id, content, embedding, memory_type, importance, created_at)
     values (coalesce($1::uuid, gen_random_uuid()), $2, $3, $4::vector(1024), $5, $6,
             coalesce($7::timestamptz, now()))
     on conflict (user_id, content_hash) do nothing
     returning id, memory_type`,
    [id ?? null, userId, content, toVectorLiteral(embedding), type, importance, createdAt ?? null],
  );

  const data = rows[0] ?? null;
  //if error - writememory error is handled vertically

  if (!data) { //if no data then skipped duplicate, so log and return null
    console.log(`skipped (duplicate) ${content}`);
    return null;
  }
  console.log(`saved [${data.memory_type}${memoryType ? "" : " (inferred)"}] ${content}`);
  return data;
}

