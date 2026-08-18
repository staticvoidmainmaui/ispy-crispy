// ─── recallContext ─── the read half of the generalized substrate.
//
// recallContext queries all five tables for context, in one statement, so the agent's multi-entity read is one consistent snapshot.
// recall.mjs stays as-is until the eval clears the switch. Two readers, one cutover.

import { pool, toVectorLiteral } from "../db/pool.mjs";
import { getEmbedding } from "./embeddings.mjs";

// ─── kind -> table ───  Frozen literal map, NOT a template of caller input.
// Interpolating a table name is only safe because the key comes from the entity_kind enum
// the database itself returned.
const TABLE_BY_KIND = Object.freeze({
  memory:         "memories",
  calendar_event: "calendar_events",
  task:           "tasks",
  signal:         "signals",
  offer:          "offers",
});

export const KINDS = Object.freeze(Object.keys(TABLE_BY_KIND));

// ─── recallContext(query, opts) → ranked rows across kinds ───
export async function recallContext(query, {
  userId,
  kinds       = null,   // null = every kind
  memoryType  = null,   // facet filter, memories branch only
  perKind     = 5,
  matchCount  = 8,
  tags        = null,
  since       = null,
} = {}) {

  if (!userId) {
    throw new Error("recallContext() requires a userId to isolate context by user.");
  }

  const queryEmbedding = await getEmbedding(query);

  const { rows } = await pool.query(
    `select * from match_context(
       $1::vector(1024), $2::uuid, $3::entity_kind[], $4::memory_type,
       $5, $6, $7::text[], $8::timestamptz)`,
    [
      toVectorLiteral(queryEmbedding),
      userId,
      kinds,
      memoryType,
      perKind,
      matchCount,
      tags,
      since,
    ],
  );

  touchAccess(rows);
  return rows;
}

// ─── Access write-back ───  the promotion signal. NOT awaited (read path).
// One UPDATE per kind present in the result — grouped, so a 5-kind result is 5 statements
// rather than 25. .catch is mandatory: a floating rejection kills the process.
function touchAccess(rows) {
  if (rows.length === 0) return;

  const idsByKind = new Map();
  for (const row of rows) {
    if (!idsByKind.has(row.kind)) idsByKind.set(row.kind, []);
    idsByKind.get(row.kind).push(row.id);
  }

  for (const [kind, ids] of idsByKind) {
    const table = TABLE_BY_KIND[kind];
    if (!table) continue; // an enum value we don't know — skip, never interpolate it

    pool.query(
      `update ${table}
          set access_count = access_count + 1, last_accessed_at = now()
        where id = any($1::uuid[])`,
      [ids],
    ).catch(err =>
      console.error(`recallContext(): access write-back failed for ${table} (non-fatal):`, err.message));
  }
}
