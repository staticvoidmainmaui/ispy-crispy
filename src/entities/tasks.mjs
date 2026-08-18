// ─── tasks ─── what is outstanding. Ingested by workflow, read by the planner.

import { withTransaction, toVectorLiteral } from "../db/pool.mjs";
import { loadSql, sqlDir } from "../db/sql.mjs";
import { getEmbedding } from "../memory/embeddings.mjs";

const SQL = sqlDir(import.meta.url);

// ─── ingestTasks(userId, items) → { inserted, updated } ───
export async function ingestTasks(userId, items) {
  const embedded = await Promise.all(items.map(async (item) => ({
    item,
    embedding: await getEmbedding(item.content),
  })));

  let inserted = 0;
  let updated = 0;

  await withTransaction(async (client) => {
    for (const { item, embedding } of embedded) {
      const { rows } = await client.query(loadSql(SQL, "upsert_task"), [
        userId,
        item.source ?? null,
        item.external_id ?? null,
        item.content,
        toVectorLiteral(embedding),
        item.title ?? item.content.slice(0, 80),
        item.state ?? null,
        item.due_at ?? null,
        item.effort_minutes ?? null,
        item.project ?? null,
        item.tags ?? [],
        JSON.stringify(item.metadata ?? {}),
        item.importance ?? null,
      ]);
      if (rows[0]?.inserted) inserted += 1; else updated += 1;
    }
  });

  return { inserted, updated };
}
