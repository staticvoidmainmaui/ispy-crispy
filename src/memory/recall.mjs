// Phase 2 — Recall (the READ half of the RAG loop).
// question in -> embed it -> ask pgvector for the nearest stored memories -> return them.
// This is your personal/recall.js, re-pointed at the upgraded `match_memories` RPC
// (which now returns id + content + memory_type + distance, scoped by user_id).
import { pool, toVectorLiteral } from "../db/pool.mjs";
import { hydrateEvents } from "../events/eventsTable.mjs";
import { getEmbedding } from "./embeddings.mjs";


// ─── recall(query, { userId, topK, memoryType }) ─────────────────────────────────
// Returns the topK memories closest in MEANING to `query`, for one user, RANKED by the
// composite score (relevance + recency + importance) the RPC now computes.
export async function recall(query, { userId, topK = 3, memoryType = null } = {}) {

  if(!userId) {
    throw new Error("recall() requires a userId to isolate memory by user.");
  }
  const queryEmbedding = await getEmbedding(query);

  //  ───  Vector Literal Translation  ───  to copy the values and match top memories in similarity ranking
  const { rows: data } = await pool.query(
    `select * from match_memories($1::vector(1024), $2, $3::uuid, $4::memory_type)`,
    [toVectorLiteral(queryEmbedding), topK, userId, memoryType],
  );

  let hydratedById;
  try {
    hydratedById = await hydrateEvents(data.map(row => row.id));
  } catch (hydrationError) {
    console.error(
      "recall(): DynamoDB hydration failed — serving pgvector content only " +
      "(events store unreachable, is DynamoDB Local running on :8000?):",
      hydrationError
    );
    hydratedById = new Map(); // empty map => merge is a no-op => raw rows pass through
  }

  const mergedData = data.map(row => {
    const hydrated = hydratedById.get(row.id);
    if (hydrated) {
      return { ...row, ...hydrated }; // prefer hydrated fields over stale content
    }
    return row; // if no hydrated record, keep the original row
  });

  return mergedData; 
}
