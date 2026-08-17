// The SQL operations ReflectAgent needs. One thin wrapper per .sql file.
// Return shape: many rows -> `rows`; unique key or do-nothing guard -> `rows[0] ?? null`.

import { pool } from "../db/pool.mjs";
import { loadSql, sqlDir } from "../db/sql.mjs";

const SQL = sqlDir(import.meta.url);

// ── Distance thresholds ──────────────────────────────────────────────────────
// Measured on Titan: restatement 0.07-0.10, contradiction 0.36-0.76, unrelated 0.66-0.92.
// Contradiction and unrelated OVERLAP — the judge is the real filter, this only
// bounds how many pairs get judged. See docs/practices/reflection_thresholds.md.
const DEFAULT_MAX_DISTANCE = 0.75;   // contradiction gate
const DEFAULT_MERGE_DISTANCE = 0.15; // restatement / cluster gate
const DEFAULT_LIMIT = 20;

// ── findContradictionCandidates ──────────────────────────────────────────────
export async function findContradictionCandidates(userId,
  { maxDistance = DEFAULT_MAX_DISTANCE, limit = DEFAULT_LIMIT } = {},
) {
  if (!userId) throw new Error("findContradictionCandidates(): consolidation requires a userId. ");
  const { rows } = await pool.query(
    loadSql(SQL, "contradiction_candidates"),
    [userId, maxDistance, limit] //input parameters
  );
  return rows;
}

// ── markSuperseded ───────────────────────────────────────────────────────────
export async function markSuperseded(loserId, winnerId) {
  if (!loserId || !winnerId) throw new Error("markSuperseded(): requires a comparable IDs. ");
  if (loserId === winnerId) throw new Error("markSuperseded(): loserID cannot equal winnerID");

  const { rows } = await pool.query(
    loadSql(SQL, "mark_superseded"),
    [loserId, winnerId]
  );
  // return null if already superseeded - nothing matched
  return rows[0] ?? null;
}

// ── findActiveUsers ──────────────────────────────────────────────────────────
export async function findActiveUsers({ lookbackDays = 7 } = {}) {
  const { rows } = await pool.query(loadSql(SQL, "active_users"), [lookbackDays]);
  return rows.map((r) => r.user_id);
}

// ── findMergeClusters ────────────────────────────────────────────────────────
// Edges in, clusters out. Single-linkage union-find: A~B and B~C => one cluster.
export async function findMergeClusters(userId, {
  maxDistance = DEFAULT_MERGE_DISTANCE, limit = 200, minSize = 2,
} = {}) {
  if (!userId) throw new Error("findMergeClusters(): requires a userId.");

  const { rows } = await pool.query(
    loadSql(SQL, "cluster_candidates"),
    [userId, maxDistance, limit],
  );
  if (rows.length === 0) return [];

  // Union-find with path compression.
  const parent = new Map();
  const find = (x) => {
    if (!parent.has(x)) parent.set(x, x);
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root);
    while (parent.get(x) !== root) { const next = parent.get(x); parent.set(x, root); x = next; }
    return root;
  };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };

  // Keep content alongside the ids — the summarizer needs the text.
  const contentById = new Map();
  for (const r of rows) {
    contentById.set(r.a_id, r.a_content);
    contentById.set(r.b_id, r.b_content);
    union(r.a_id, r.b_id);
  }

  const byRoot = new Map();
  for (const id of contentById.keys()) {
    const root = find(id);
    if (!byRoot.has(root)) byRoot.set(root, []);
    byRoot.get(root).push({ id, content: contentById.get(id) });
  }

  // Biggest clusters first — most redundancy removed if a run is cut short.
  return [...byRoot.values()]
    .filter(members => members.length >= minSize)
    .sort((a, b) => b.length - a.length);
}

// ── markConsolidated ─────────────────────────────────────────────────────────
export async function markConsolidated(memberId, summaryId) {
  if (!memberId || !summaryId) throw new Error("markConsolidated(): requires both ids.");
  if (memberId === summaryId) throw new Error("markConsolidated(): a summary cannot consolidate itself.");

  const { rows } = await pool.query(loadSql(SQL, "mark_consolidated"), [memberId, summaryId]);
  return rows[0] ?? null; // null = already consolidated by an earlier pass
}

// ── expireWorking ────────────────────────────────────────────────────────────
// Backfill expires_at on working rows that never got one.
export async function expireWorking(userId, { ttlHours = 24 } = {}) {
  if (!userId) throw new Error("expireWorking(): requires a userId.");
  const { rows } = await pool.query(loadSql(SQL, "expire_working"), [userId, ttlHours]);
  return rows;
}

// ── findUntagged ─────────────────────────────────────────────────────────────
export async function findUntagged(userId, { limit = 100 } = {}) {
  if (!userId) throw new Error("findUntagged(): requires a userId.");
  const { rows } = await pool.query(loadSql(SQL, "untagged_memories"), [userId, limit]);
  return rows;
}

// ── setTags ──────────────────────────────────────────────────────────────────
export async function setTags(memoryId, tags) {
  if (!memoryId) throw new Error("setTags(): requires a memoryId.");
  if (!Array.isArray(tags) || tags.length === 0) return null; // nothing to write
  const { rows } = await pool.query(loadSql(SQL, "set_tags"), [memoryId, tags]);
  return rows[0] ?? null; // null = row already had tags
}

// ── promoteHot ───────────────────────────────────────────────────────────────
export async function promoteHot(userId, { minAccess = 5 } = {}) {
  if (!userId) throw new Error("promoteHot(): requires a userId.");
  const { rows } = await pool.query(loadSql(SQL, "promote_hot"), [userId, minAccess]);
  return rows;
}
