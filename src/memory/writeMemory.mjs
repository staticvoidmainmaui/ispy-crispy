// Phase 1 — Embed-on-write (typed).
// The "write half" of the RAG loop: text in -> embed -> INSERT a TYPED row.
// This is your personal/writeMemory_P.mjs, grown up: it now sets memory_type,
// importance, and user_id so the row is useful for Scale B, not just a text dump.

import { pipeline } from "@xenova/transformers";
import { createClient } from "@supabase/supabase-js";


// TODO: move these to env vars before this is anything but a demo.
const supabaseUrl = "https://ovecipojbgnmptuyguor.supabase.co";
const supabaseAnonKey = "sb_publishable_TF5VplQM5Flb6zhXZz47Xw_8fC4Pzc4";
const supabase = createClient(supabaseUrl, supabaseAnonKey);

// Local MiniLM (Xenova) = text -> 384 numbers. Loaded once, reused (that's the `if`).
let embedder;
async function getEmbedding(text) {
  if (!embedder) {
    embedder = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
  }
  const output = await embedder(text, { pooling: "mean", normalize: true });
  return Array.from(output.data);
}

// ─────────────────────────────────────────────────────────────────────────────
// THE CLASSIFICATION DECISION — episodic vs semantic.
//
//   • episodic = a thing that happened / will happen  ("dentist appt Friday 3pm")
//   • semantic = a durable preference or fact          ("prefers morning study blocks")
//
// Why it matters: recall later injects SEMANTIC memories into the prompt to
// personalize, but treats EPISODIC ones as calendar facts. Mislabel and the planner
// either forgets your preferences or "remembers" that one Tuesday forever.

// Cosine similarity of two vectors. MiniLM output is already normalized, so magnitudes
// are ~1 and the dot product alone equals cosine — the full formula is kept so it's
// correct for any vectors.
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
// So `memoryType` is an explicit, authoritative argument. No noisy phrase-matching,
// no magic margin, no drift. This is exactly the Phase 3 "split writes by source" call.
//
// inferMemoryType() is only the FALLBACK for genuinely typeless input (a freeform note
// where origin tells you nothing). Kept intentionally conservative: default to
// `episodic`, because a wrong `semantic` leaks a fake preference into every future
// prompt, while a wrong `episodic` just sits inertly in the recall index.
//
// PHASE 3 UPGRADE (seam left on purpose): when the app's tiered NLP is wired in,
// replace the cosine fallback body with the existing Claude classifier — reasoning
// beats prototype-distance for the ambiguous cases. Signature stays identical.
const SEMANTIC_PROTOTYPE = await getEmbedding("a lasting personal preference or habit i tend to have");
const EPISODIC_PROTOTYPE = await getEmbedding("an appointment or event happening at a specific date or time");

const VALID_TYPES = new Set(["episodic", "semantic", "procedural", "working", "consolidated"]);
const CLASSIFY_MARGIN = 0.05; // fallback only: semantic must clearly beat episodic to win

function inferMemoryType(embedding) {
  const semScore = similarity(embedding, SEMANTIC_PROTOTYPE);
  const epiScore = similarity(embedding, EPISODIC_PROTOTYPE);
  return semScore - epiScore > CLASSIFY_MARGIN ? "semantic" : "episodic";
}


//TODO: use the same UUID for the memory and event tables, so that the recall function can fetch the authoritative event details from DynamoDB by that id.
// export async function writeMemory(content, { userId, memoryType, importance = "medium" , id: eventId } = {}) {
// }
//.js doesnt do function  overloading
//instead 
export async function writeMemory(content, { userId, memoryType, importance = "medium", id, createdAt } = {}) {

  if (!userId) throw new Error("writeMemory needs a userId (per-user isolation).");
  if (memoryType && !VALID_TYPES.has(memoryType)) {
    throw new Error(`invalid memoryType "${memoryType}"`);
  }

  // Embed ONCE. Reuse the vector for both the row and (if needed) the fallback inference.
  const embedding = await getEmbedding(content);

  // Authoritative if the caller passed it; inferred only as a last resort.
  const type = memoryType ?? inferMemoryType(embedding);

  // Upsert (not insert): if this user already stored identical content, the unique index
  // uq_memories_user_content (user_id, content_hash) makes this a no-op instead of a dup.
  // ignoreDuplicates=true => existing row is left untouched; re-running writeMemory is safe.
  const { data, error } = await supabase
    .from("memories")
    .upsert(
      { ...(id && { id }), ...(createdAt && { created_at: createdAt }), user_id: userId, content, embedding, memory_type: type, importance },
      { onConflict: "user_id,content_hash", ignoreDuplicates: true }
    )
    // maybeSingle (not single): a skipped duplicate returns zero rows, which is NOT an
    // error here — single() would treat "no rows" as an error, maybeSingle() gives null.
    .select("id, memory_type")
    .maybeSingle();

  if (error) {
    console.error("writeMemory failed:", error.message);
    return null;
  }
  if (!data) { //if no data then skipped duplicate, so log and return null
    console.log(`skipped (duplicate) ${content}`);
    return null;
  }
  console.log(`saved [${data.memory_type}${memoryType ? "" : " (inferred)"}] ${content}`);
  return data;
}

// Quick manual smoke test — run: node src/memory/writeMemory.mjs
// Events pass an explicit type (the real path); the freeform note exercises the fallback.
const DEV_USER = "00000000-0000-0000-0000-000000000001";
// await writeMemory("Dentist appointment Friday 3pm", { userId: DEV_USER, memoryType: "episodic" });
// await writeMemory("I prefer studying in the morning and hate Monday meetings", { userId: DEV_USER, memoryType: "semantic" });
// await writeMemory("Buy groceries", { userId: DEV_USER }); // no type -> inferred
