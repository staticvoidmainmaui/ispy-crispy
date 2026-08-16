// The two SQL operations ReflectAgent needs. 

import { pool } from "../db/pool.mjs";
import { loadSql, sqlDir } from "../db/sql.mjs";

const SQL = sqlDir(import.meta.url);

const DEFAULT_MAX_DISTANCE = 0.25;
const DEFAULT_LIMIT = 20;

// ── findContradictionCandidates ──────────────────────────────────────────────
export async function findContradictionCandidates(userId, 
  { maxDistance = DEFAULT_MAX_DISTANCE, limit = DEFAULT_LIMIT } = {},
) {
  if(!userId) throw new Error("findContradictionCandidates(): consolidation requires a userId. ");
  //   Param order must match the $1/$2/$3 in the file: id, max distance, and limit. Return rows.
  //   Note maxDistance is a float and limit an int — no casts needed, but if CockroachDB
  //   complains about an untyped placeholder, that's where ::float / ::int go.
  const { rows } = await pool.query(
    loadSql(SQL,"contradiction_candidates"), 
    [userId, maxDistance,limit] //input parameters
  );
  return rows;
}

// ── markSuperseded ───────────────────────────────────────────────────────────
export async function markSuperseded(loserId, winnerId) {
  if(!loserId || !winnerId) throw new Error("markSuperseded(): requires a comparable IDs. ");
  if(loserId === winnerId) throw new Error("markSuperseded(): loserID cannot equal winnerID");


  const {rows} = await pool.query(
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
