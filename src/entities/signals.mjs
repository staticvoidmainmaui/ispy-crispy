// ─── signals ─── inbound events, and the digest that cites them.

import { pool, withTransaction, toVectorLiteral } from "../db/pool.mjs";
import { loadSql, sqlDir } from "../db/sql.mjs";
import { getEmbedding } from "../memory/embeddings.mjs";

const SQL = sqlDir(import.meta.url);

// Measured Titan bands (docs/journal.md, consolidation.mjs): restatement 0.07-0.10,
// contradiction 0.36-0.76, unrelated 0.66-0.92. 0.45 keeps topical affinity and drops
// unrelated. Expect to tune — record the tuning the way the reflection thresholds were.
export const CITATION_GATE = 0.45;

// ─── ingestSignals(userId, items) → { inserted, updated, errors } ───
// Embeddings first, transaction second: a Bedrock round trip per item inside BEGIN would
// hold a connection for the length of the batch.
export async function ingestSignals(userId, items) {
  const embedded = await Promise.all(items.map(async (item) => ({
    item,
    embedding: await getEmbedding(item.content),
  })));

  let inserted = 0;
  let updated = 0;

  await withTransaction(async (client) => {
    for (const { item, embedding } of embedded) {
      const { rows } = await client.query(loadSql(SQL, "upsert_signal"), [
        userId,
        item.source,
        item.external_id,
        item.content,
        toVectorLiteral(embedding),
        item.title ?? null,
        item.url ?? null,
        item.occurred_at ?? null,
        item.tags ?? [],
        JSON.stringify(item.metadata ?? {}),
        item.importance ?? null,
      ]);
      if (rows[0]?.inserted) inserted += 1; else updated += 1;
    }
  });

  return { inserted, updated };
}

// ─── digest(userId, { since, gate, limit }) → { items, considered, skipped } ───
// The skip count is the product. Invisible filtering isn't believable, so the number that
// justifies the filtering is computed here and returned alongside what survived it.
export async function digest(userId, { since, gate = CITATION_GATE, limit = 5 } = {}) {
  const [cited, counted] = await Promise.all([
    pool.query(loadSql(SQL, "digest_signals"), [userId, since, gate, limit]),
    pool.query(loadSql(SQL, "count_signals"), [userId, since]),
  ]);

  const considered = counted.rows[0]?.considered ?? 0;

  return {
    items: cited.rows,
    considered,
    skipped: Math.max(considered - cited.rows.length, 0),
    gate,
  };
}
