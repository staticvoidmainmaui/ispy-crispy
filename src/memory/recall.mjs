// Phase 2 — Recall (the READ half of the RAG loop).
// question in -> embed it -> ask pgvector for the nearest stored memories -> return them.
// This is your personal/recall.js, re-pointed at the upgraded `match_memories` RPC
// (which now returns id + content + memory_type + distance, scoped by user_id).
//
// Build it yourself from the TODOs below — retrieval is the half worth understanding by hand.
// Reuse the SAME getEmbedding you wrote in writeMemory.mjs so the query vector is produced
// the exact same way the stored vectors were (same model, same pooling, same normalize).

import { pipeline } from "@xenova/transformers";
import { createClient } from "@supabase/supabase-js";
import { hydrateEvents } from "../events/eventsTable.mjs";
import { getEmbedding } from "./embeddings.mjs";

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_API_KEY;
const supabase = createClient(supabaseUrl, supabaseAnonKey);



// ─── recall(query, { userId, topK, memoryType }) ─────────────────────────────────
// Returns the topK memories closest in MEANING to `query`, for one user, RANKED by the
// composite score (relevance + recency + importance) the RPC now computes.
//
// SETUP CHECK: db/04_match_memories_ranked.sql must be run in Supabase so the upgraded
// RPC `match_memories(query_embedding, match_count, p_user_id, p_memory_type)` exists.
//
// memoryType: optional pre-filter. Pass "semantic" to recall ONLY preferences, "episodic"
//   for ONLY calendar facts, or leave undefined to search across all types. This is the
//   metadata pre-filtering half of the retrieval upgrade — it narrows the candidate set
//   in SQL (the WHERE) before ranking, so a preference lookup never competes with events.
export async function recall(query, { userId, topK = 3, memoryType = null } = {}) {
  // TODO 1: guard — throw if no userId (same isolation rule as writeMemory).
  if(!userId) {
    throw new Error("recall() requires a userId to isolate memory by user.");
  }


  // TODO 2: turn the QUESTION into a vector.
  const queryEmbedding = await getEmbedding(query);
  if(queryEmbedding.length !== 384) {
    throw new Error(`Unexpected embedding length: ${queryEmbedding.length}. Expected 384.`);
  }
  //   const queryEmbedding = await getEmbedding(query);
  //   (sanity: queryEmbedding.length should be 384 — log it once if unsure.)

  // The RPC now declares FOUR params. p_memory_type is optional — Supabase omits any key
  // you don't pass, and the SQL default (null = all types) kicks in. So passing
  // `p_memory_type: null` and passing nothing are equivalent here.
  // TODO: forward memoryType as p_memory_type so the pre-filter actually fires.
  const { data, error } = await supabase.rpc("match_memories", {
    query_embedding: queryEmbedding,
    match_count: topK,
    p_user_id: userId,
    p_memory_type: memoryType   // null => SQL default => no filter
  });
  
  // TODO 4: if (error) -> console.error and return [] (never throw raw on a read path). ✅ DONE
  if (error) {
    console.error("Error calling match_memories RPC:", error);
    return [];
  }
  // TODO 5: return the rows. DONE BELOW !

  // TODO 6: hydrate. `data` is Stage 1 (pgvector FIND) — each row's `id` is a candidate
    //   eventId, `content` is a stale snapshot, not the canonical record. Stage 2 (DynamoDB
      //   HYDRATE) fetches the current, authoritative record by that same id.
        //   - Call hydrateEvents(data.map(row => row.id)) from src/events/eventsTable.mjs
          //     -> returns a Map(id -> event).
            //   - Merge: for each row, look up hydrated = hydratedById.get(row.id).
              //     If found, prefer the hydrated fields (title/time/location/status) over `content`.
                //     If NOT found (event deleted, or this memory has no matching event — e.g. a
                  //     semantic preference that was never written to DynamoDB), just keep the row
                    //     as-is — hydration is a merge, not a requirement.
  //   - Return the merged rows instead of the raw `data`.
  
  //
  // RESILIENCE (Stage 2 is an ENRICHMENT, not a requirement):
  //   hydrateEvents talks to DynamoDB Local (port 8000). That container is a separate,
  //   often-not-running process — if it's down, the AWS SDK throws ECONNREFUSED and,
  //   without this guard, that exception would propagate all the way up and 500 the
  //   ENTIRE chat request — even for semantic memories (preferences, facts) that never
  //   had a DynamoDB event to hydrate in the first place. That's a bad failure mode: a
  //   missing enrichment store should not take down retrieval.
  //
  //   So we degrade gracefully instead: catch the hydration failure, log it loudly so
  //   the outage is visible, and fall back to an EMPTY hydration map. Every row then
  //   flows through the merge below untouched, keeping its pgvector `content` snapshot.
  //   The answer is less precise (stale content instead of the authoritative record),
  //   but the user still gets a grounded reply rather than an error page.
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

  //mauimir: 
  //the pattern is a map of a lookup of a record then mergin together. 
  //.map is iterating over the entire data array.
  //essentially lambda literal to merge the data from the RPC call with the hydrated data from DynamoDB.
  //the hydrated const uses .get(row.id) to map lookup id to corresponding record and returns a merged object which then is returned in merged data array.


  return mergedData; 
}
// ─────────────────────────────────────────────────────────────────────────────

// Quick manual smoke test — run: node src/memory/recall.mjs
// (must run writeMemory.mjs first so there are rows to find, and use the SAME DEV_USER)
// const DEV_USER = "00000000-0000-0000-0000-000000000001";

// const smokeTestQueries = [
//   "When is my appointment today?",
//   "What do I need to buy?",
//   "What are my personal preferences?",
//   "things I need to do this week",
// ];

// //make it so just the top 3 hits print and thats all

// const smokeTestOptions = { userId: DEV_USER, topK: 3 };
// for (const [index, query] of smokeTestQueries.entries()) {
//   console.log(`\nQuery ${index + 1}: ${query}`);
//   const hits = await recall(query, smokeTestOptions);
//   if (!hits.length) {
//     console.log("  - no hits");
//     continue;
//   }
//   // distance = cosine distance from match_memories: smaller = closer in meaning.
//   // Rank 1 is the best match; printing distance lets you eyeball how confident it is.
//   hits.forEach((hit, rank) =>
//     console.log(`  ${rank + 1}. [${hit.memory_type}] ${hit.content}  (distance ${hit.distance.toFixed(3)})`)
//   );
// }


// WIN CONDITION: a query like "what do I need to buy" ranks "Buy groceries" first;
// "when is my appointment" ranks the dentist memory first. When that holds, the RAG
// retrieval loop is closed end to end — that's the Scale A / MVP cut line.