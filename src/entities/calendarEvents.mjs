// ─── calendar_events ─── replaces src/events/ entirely.
//
// The old shape was two stores and one shared UUID: DynamoDB held the authoritative
// record, CockroachDB held a searchable projection, and nothing joined them but a string.
// Here the searchable surface and the record are the same row, so there is no drift to
// reconcile and no hydration to degrade.

import { pool, toVectorLiteral } from "../db/pool.mjs";
import { loadSql, sqlDir } from "../db/sql.mjs";
import { getEmbedding } from "../memory/embeddings.mjs";

const SQL = sqlDir(import.meta.url);

// ─── renderContent(...) → the embedded surface ───
// Location goes IN, deliberately: docs/journal.md's demo-2 note was that location lived
// only in DynamoDB, so recall could find the event but not act on it. Now the row that
// ranks is the row that carries the place name.
export function renderContent({ title, startsAt, location }) {
  const when = startsAt ? ` on ${startsAt}` : "";
  const where = location ? ` at ${location}` : "";
  return `${title}${when}${where}`;
}

// ─── createCalendarEvent(fields) → the inserted row ───
// `content`/`embedding` are accepted pre-computed so the approval path can embed BEFORE
// opening its transaction, and `client` so the insert lands inside it.
export async function createCalendarEvent({
  userId, title, startsAt,
  endsAt = null, location = null, placeLat = null, placeLon = null,
  status = null, source = null, tags = [], metadata = {},
  importance = null, createdAt = null, id = null,
  content = null, embedding = null, client = pool,
} = {}) {

  if (!userId) throw new Error("createCalendarEvent() requires a userId.");
  if (!title)  throw new Error("createCalendarEvent() requires a title.");
  if (!startsAt) throw new Error("createCalendarEvent() requires a startsAt.");

  const text = content ?? renderContent({ title, startsAt, location });
  const vector = embedding ?? await getEmbedding(text);

  const { rows } = await client.query(loadSql(SQL, "insert_calendar_event"), [
    id, userId, text, toVectorLiteral(vector),
    title, startsAt, endsAt, location,
    placeLat, placeLon, status, source,
    tags, JSON.stringify(metadata), importance, createdAt,
  ]);

  return rows[0];
}

// ─── listEvents(userId, { from, to, limit }) → time-ordered rows ───
export async function listEvents(userId, { from = null, to = null, limit = 20 } = {}) {
  if (!userId) throw new Error("listEvents() requires a userId.");

  const { rows } = await pool.query(loadSql(SQL, "list_calendar_events"),
    [userId, from, to, limit]);

  return rows;
}

// ─── updateCalendarEvent(id, userId, changes, client?) → the updated row ───
// Takes an optional pg client so the approval path can run it INSIDE the same transaction
// that flips proposed_actions to 'applied'. Defaults to the pool for standalone use.
export async function updateCalendarEvent(id, userId, changes = {}, client = pool) {
  const {
    content = null, embedding = null, title = null,
    startsAt = null, endsAt = null, location = null,
    placeLat = null, placeLon = null, status = null,
  } = changes;

  const { rows } = await client.query(loadSql(SQL, "update_calendar_event"), [
    id, userId, content, embedding ? toVectorLiteral(embedding) : null, title,
    startsAt, endsAt, location, placeLat, placeLon, status,
  ]);

  return rows[0] ?? null;
}

// ─── createEvent(title, time, location, userId) → id ───
// Positional compat shim for the one call site in handleMessage. Same signature the
// DynamoDB version had, so the COMMAND path in the intent fork is unchanged.
export async function createEvent(title, time, location, userId) {
  const row = await createCalendarEvent({ userId, title, startsAt: time, location });
  return row.id;
}
