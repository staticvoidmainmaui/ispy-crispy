// ensure-table.mjs
//Run with 
//node --env-file=.env ensure-table.mjs

import { ensureEventsTable } from "../src/events/eventsTable.mjs";

await ensureEventsTable();
console.log("Events table ready.");
