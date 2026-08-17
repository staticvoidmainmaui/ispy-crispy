// The SQL operations ReflectAgent needs. One thin wrapper per .sql file, no logic
// beyond argument checks and shaping the return.
//
// Return-shape convention: a query that can match many rows returns `rows`; a query
// keyed on a unique id or guarded by a do-nothing clause returns `rows[0] ?? null`.

import { pool } from "../db/pool.mjs";
import { loadSql, sqlDir } from "../db/sql.mjs";

const SQL = sqlDir(import.meta.url);

// ── Distance thresholds — MEASURED, not guessed ──────────────────────────────
// Embedded hand-built pairs against Bedrock Titan and compared cosine distance:
//   restatement   0.07 – 0.10   ("I like Thai food" / "Thai food is my favorite")
//   contradiction 0.36 – 0.76   ("I prefer mornings" / "I prefer afternoons now")
//   unrelated     0.66 – 0.92   ("I hate mornings" / "I prefer tea over coffee")
//
// Two conclusions, and they are not symmetric:
//
// MERGE is cleanly separable. Restatement tops out at 0.10 and the nearest
// contradiction sits at 0.36, so 0.15 has room on both sides.
//
// CONTRADICTION is NOT. Its band runs to 0.76 while unrelated starts at 0.66 — they
// OVERLAP, so no threshold divides them. The Haiku judge is the real filter; this
// number only bounds how many pairs we pay to judge. 0.75 keeps recall high and
// accepts that some judged pairs come back "compatible". Tightening it does not buy
// precision, it just silently drops real contradictions.
//
// Titan's distances are compressed into a narrow high band, so numbers tuned for
// MiniLM do not transfer. The old defaults were wrong in both directions: 0.25 here
// (below EVERY contradiction — reflection was a silent no-op) and 0.85 in
// reflectAgent (deep into unrelated noise).
const DEFAULT_MAX_DISTANCE = 0.75;  // contradiction gate
const DEFAULT_MERGE_DISTANCE = 0.15; // restatement / cluster gate
const DEFAULT_LIMIT = 20;

// ── findContradictionCandidates ──────────────────────────────────────────────
export async function findContradictionCandidates(userId,
  { maxDistance = DEFAULT_MAX_DISTANCE, limit = DEFAULT_LIMIT } = {},
) {
  if (!userId) throw new Error("findContradictionCandidates(): consolidation requires a userId. ");
  //   Param order must match the $1/$2/$3 in the file: id, max distance, and limit. Return rows.
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
// Edges in, CLUSTERS out. The SQL returns pairs; grouping happens here.
//
// Single-linkage via union-find: if A~B and B~C then A, B and C are one cluster, even
// when A and C are further apart than the threshold. That transitivity is the point —
// three ways of saying the same thing should collapse into one summary, not two.
//
// Why Node and not SQL: transitive closure is a recursive CTE and this is a nightly
// batch job, not a ranking query. Pattern #8 puts RANKING in SQL; it doesn't demand
// every algorithm live there.
export async function findMergeClusters(userId, {
  maxDistance = DEFAULT_MERGE_DISTANCE, limit = 200, minSize = 2,
} = {}) {
  if (!userId) throw new Error("findMergeClusters(): requires a userId.");

  const { rows } = await pool.query(
    loadSql(SQL, "cluster_candidates"),
    [userId, maxDistance, limit],
  );
  if (rows.length === 0) return [];

  // Union-find with path compression. `parent` maps id -> representative id.
  const parent = new Map();
  const find = (x) => {
    if (!parent.has(x)) parent.set(x, x);
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root);
    while (parent.get(x) !== root) { const next = parent.get(x); parent.set(x, root); x = next; }
    return root;
  };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };

  // Keep content alongside the ids — the summarizer needs the text, and re-reading
  // it from the DB would be a second round-trip for data we already have.
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

  // Biggest clusters first: they carry the most redundancy, so if a run is cut short
  // by the pair limit the highest-value merges are the ones that happened.
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
// The durable half of promotion: bump importance one step for memories recalled
// often enough to have proven they matter.
export async function promoteHot(userId, { minAccess = 5 } = {}) {
  if (!userId) throw new Error("promoteHot(): requires a userId.");
  const { rows } = await pool.query(loadSql(SQL, "promote_hot"), [userId, minAccess]);
  return rows;
}
