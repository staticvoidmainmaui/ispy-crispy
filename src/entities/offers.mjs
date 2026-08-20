// ─── offers ─── filled by a workflow, filtered by remembered preferences.

import { pool, withTransaction, toVectorLiteral } from "../db/pool.mjs";
import { loadSql, sqlDir } from "../db/sql.mjs";
import { getEmbedding } from "../memory/embeddings.mjs";

const SQL = sqlDir(import.meta.url);

// ─── ingestOffers(userId, items) → { inserted, updated } ───
export async function ingestOffers(userId, items) {
  const embedded = await Promise.all(items.map(async (item) => ({
    item,
    embedding: await getEmbedding(item.content),
  })));

  let inserted = 0;
  let updated = 0;

  await withTransaction(async (client) => {
    for (const { item, embedding } of embedded) {
      const { rows } = await client.query(loadSql(SQL, "upsert_offer"), [
        userId,
        item.retailer ?? item.source ?? "unknown",
        item.external_id,
        item.content,
        toVectorLiteral(embedding),
        item.brand ?? null,
        item.model ?? null,
        item.price_cents ?? null,
        item.currency ?? null,
        item.size ?? null,
        JSON.stringify(item.attributes ?? {}),
        item.url ?? null,
        item.in_stock ?? null,
        item.tags ?? [],
        JSON.stringify(item.metadata ?? {}),
      ]);
      if (rows[0]?.inserted) inserted += 1; else updated += 1;
    }
  });

  return { inserted, updated };
}

// ─── searchOffers(userId, query, constraints) → rows ───
export async function searchOffers(userId, query, {
  maxPriceCents = null, size = null, attributes = null,
  excludeBrands = null, limit = 3,
} = {}) {
  const embedding = await getEmbedding(query);

  const { rows } = await pool.query(loadSql(SQL, "search_offers"), [
    userId,
    toVectorLiteral(embedding),
    maxPriceCents,
    size,
    attributes ? JSON.stringify(attributes) : null,
    excludeBrands,
    limit,
  ]);

  return rows;
}
