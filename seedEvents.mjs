// seedEvents.mjs — re-hydrate DynamoDB Local after a wipe, WITHOUT breaking id alignment.
//
// Why not just re-run createEvent()? Because createEvent() mints a NEW randomUUID each
// time. Your Postgres episodic rows already exist (cloud, persisted) with their ORIGINAL
// ids. The only correct re-seed is: read those existing ids from Postgres and mirror
// each one into the fresh DynamoDB under the SAME id, so recall's Stage-2 hydration
// (memory.id -> getEvent(id)) lines up again.
//
// Run:  node --env-file=.env seedEvents.mjs
//
// NOTE: DynamoDB event records normally carry structured title/time/location/status.
// Postgres only stored `content` ("<title> on <time>"), so we reconstruct what we can
// by splitting on " on ". Good enough to prove hydration; real events would be richer.

import { createClient } from "@supabase/supabase-js";
import { ensureEventsTable, putEvent } from "./src/events/eventsTable.mjs";
import { DEV_USER } from "./src/config.mjs";

// Same project as writeMemory.mjs / recall.mjs.
const supabase = createClient(
  "https://ovecipojbgnmptuyguor.supabase.co",
  "sb_publishable_TF5VplQM5Flb6zhXZz47Xw_8fC4Pzc4"
);

// 1. Pull the episodic rows Postgres already knows about (these hold the canonical ids).
const { data: rows, error } = await supabase
  .from("memories")
  .select("id, content, memory_type")
  .eq("user_id", DEV_USER)
  .eq("memory_type", "episodic");

if (error) throw error;
console.log(`Found ${rows.length} episodic memory rows for DEV_USER.`);

// 2. Make sure the (empty) local table exists before we write into it.
await ensureEventsTable();

// 3. Mirror each into DynamoDB under its EXISTING id — this is the alignment that matters.
for (const row of rows) {
  const [title, time] = row.content.split(" on ");   // best-effort reconstruction
  await putEvent({
    id: row.id,                 // <-- SAME id as the Postgres row. The whole point.
    title: title?.trim() ?? row.content,
    time: time?.trim() ?? null,
    location: null,
    status: "scheduled",
  });
  console.log(`  seeded ${row.id}  ->  ${row.content}`);
}

console.log("Done. DynamoDB now mirrors the Postgres episodic ids.");