// Events table — the "source of truth" half of the fusion (see docs/05_learning_path.md).
// pgvector (recall.mjs) FINDS candidate ids by meaning. This file HYDRATES those ids
// into the real, current record. Two different jobs, two different stores:
//   - memories (Postgres/pgvector): fuzzy, "what's relevant"        -> can go stale
//   - events   (this table, DynamoDB): exact, key-based, "what's true right now"
//
// Build it yourself from the TODOs — this is the DynamoDB equivalent of what
// writeMemory.mjs/recall.mjs already taught you for Postgres.
//
// Docs to read before you write each function:
//   - PutItem  (write one item):   https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/lib-dynamodb/Class/PutCommand/
//   - GetItem  (read one item by key): https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/lib-dynamodb/Class/GetCommand/
//   - BatchGetItem (read many items by key in one round trip):
//     https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/lib-dynamodb/Class/BatchGetCommand/
//   - Why "id" alone is enough as a key here: DynamoDB tables are schemaless except for
//     their key — no CREATE TABLE with columns like SQL. You declare the key in the
//     table definition (see setupTable() below) and every item can otherwise carry
//     whatever attributes it wants.

import {
  PutCommand,
  GetCommand,
  BatchGetCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  CreateTableCommand,
  DescribeTableCommand,
} from "@aws-sdk/client-dynamodb";
import { docClient, EVENTS_TABLE, IS_LOCAL_DYNAMO } from "./dynamoClient.mjs";

// ─── One-time setup: create the table if it doesn't exist ───────────────────────
// Real AWS: you'd normally do this once via Terraform/CDK/console, not app code.
// Locally: DynamoDB Local starts empty every time (we run it -inMemory), so this
// makes the table idempotently on startup — convenient for a demo/dev loop.
export async function ensureEventsTable() {
  try {
    await docClient.send(new DescribeTableCommand({ TableName: EVENTS_TABLE }));
    return; // already exists
  } catch (err) {
    if (err.name !== "ResourceNotFoundException") throw err;
  }

  // Real AWS: the table is infrastructure, not something app code conjures.
  if (!IS_LOCAL_DYNAMO) {
    throw new Error(
      `ensureEventsTable(): table "${EVENTS_TABLE}" does not exist in ${process.env.AWS_REGION ?? "us-east-1"}. ` +
      `Create it out-of-band; app code only auto-creates against DynamoDB Local.`,
    );
  }

  // TODO 1: define the table's key schema.
  //   - KeySchema: a single partition key named "id", KeyType "HASH".
  //   - AttributeDefinitions: declare "id" as attribute type "S" (string) — DynamoDB
  //     only needs types for attributes that are part of a key, everything else
  //     (title, time, location, ...) is schemaless.
  //   - BillingMode: "PAY_PER_REQUEST" (no need to provision read/write capacity).
  // await docClient.send(new CreateTableCommand({ ... }));
  await docClient.send(new CreateTableCommand({
    TableName: EVENTS_TABLE,
    KeySchema: [ //declare key schema for the table, specifying the primary key attribute and its type
      { AttributeName: "id", KeyType: "HASH" }
    ],
    AttributeDefinitions: [ //define the attributes used in the key schema, specifying their names and data types
      { AttributeName: "id", AttributeType: "S" }
    ],
    BillingMode: "PAY_PER_REQUEST"
  }));
}

// ─── putEvent(event) — write ONE authoritative event record ────────────────────
// `event` must include an `id` — this MUST be the same id you use for the matching
// row in the `memories` table (see writeMemory.mjs), so recall's Stage 1 result can
// be used as the Stage 2 lookup key.
export async function putEvent(event) { 
  // TODO 2: guard — throw if no event.id (same isolation rule as writeMemory/recall).
  if (!event.id) {
    throw new Error("putEvent() requires an event.id to isolate records by id.");
  }
  // TODO 3: docClient.send(new PutCommand({ TableName: EVENTS_TABLE, Item: event }))
  await docClient.send(new PutCommand({ TableName: EVENTS_TABLE, Item: event }));
}
//mauimirs commentary: 
//export keyword is used to make the functions available for import in other modules.
//async keyword is used to define asynchronous functions that return a Promise, allowing for the use of await within the function body.
//await keyword is used to pause the execution of the function until the Promise returned by the asynchronous operation is resolved or rejected, 
// allowing for a more readable and sequential code flow.
//a promise is an object marked for eventual completion, in C++ its comparable to a future.

// ─── getEvent(id) — fetch ONE event by id ───────────────────────────────────────
export async function getEvent(id) { 
  // TODO 4: docClient.send(new GetCommand({ TableName: EVENTS_TABLE, Key: { id } }))
  //   Destructure { Item } from the result — undefined if no row matches that id.
  const { Item } = await docClient.send(new GetCommand({ TableName: EVENTS_TABLE, Key: { id } } ) ) ;
  return Item; // so it can return empty if not found instread of throwing 
}

// ------------ TODO 6 ------------------------------
// ─── hydrateEvents(ids) — fetch MANY events by id in one round trip ────────────


// This is the function recall.mjs's TODO 6 should call: take the ids pgvector
// returned, batch-fetch the current records, return them indexed by id so the
// caller can zip hydrated data back onto the pgvector hits (distance, etc).
export async function hydrateEvents(ids) {
  if (ids.length === 0) return new Map(); // BatchGetCommand rejects an empty Keys array

  // TODO 5: docClient.send(new BatchGetCommand({
  //   RequestItems: { [EVENTS_TABLE]: { Keys: ids.map((id) => ({ id })) } }
  // }))
  //   Destructure { Responses } from the result — Responses[EVENTS_TABLE] is an
  //   array of the found items (BatchGet silently drops ids that don't exist —
  //   don't assume the array is the same length as `ids`).
  //   Build and return a Map(id -> item) so callers can do hydratedById.get(hit.id).
  
  const { Responses } = await docClient.send(new BatchGetCommand({
    RequestItems: { [EVENTS_TABLE]: { Keys: ids.map((id) => ({ id })) } }
  }));

  //mauimir commentary:
  // Responses[EVENTS_TABLE] is an array of the found items (BatchGet silently drops ids that don't exist).
  //we canot build the map before doing the batch get command because we need to wait for the response from the database before we can build the map.
  //map pattern explained:
  // The map pattern is a common programming technique used to transform or process elements in a collection (like an array) and create a new collection based on the results.
  // In this case, we are using the map pattern to transform an array of ids into an array of objects with a specific structure ({ id }).
  // The map function takes each element in the input array (ids) and applies a transformation function to it, returning a new array with the transformed elements.
  // In this case, we are creating an object with a single property id for each element in the ids array.
  // This is useful when we need to send a batch request to the database, as we need to provide an array of objects with the correct structure for the request.
  
  // Build a Map(id -> item) from the responses
  const hydratedById = new Map();
  if (Responses[EVENTS_TABLE]) {
    Responses[EVENTS_TABLE].forEach((item) => {
      hydratedById.set(item.id, item); //item.id is the event ID, item is the object returned from the database
    });
  }

  return hydratedById;
}

// ─── updateEvent(id, changes) — mutate an EXISTING event ────────────────────────
// putEvent() always does a full overwrite of an item by id — there's no partial
// "just change these fields" call in what you've built so far. updateEvent is that:
// read the current item, merge in `changes`, write the merged result back.
//
// Why fetch-then-put instead of DynamoDB's native UpdateItem command? UpdateItem
// (see docs) can patch individual attributes server-side without a round trip, and
// is the "correct" production answer once you're comfortable — but fetch/merge/put
// reuses functions you already wrote and understand (getEvent, putEvent), which is
// the point right now. Revisit with UpdateItem later:
// https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/lib-dynamodb/Class/UpdateCommand/
export async function updateEvent(id, changes) {
  // TODO 6: guard — throw if no id (same isolation rule as putEvent/getEvent).
  if (!id) {
    throw new Error("updateEvent() requires an id to isolate records by id.");
  }

  // TODO 7: fetch the existing event with getEvent(id).
  const existing = await getEvent(id);
  if (!existing) {
    throw new Error(`Event with id "${id}" not found. Cannot update non-existent event.`);
  }
  //   If it doesn't exist (undefined), throw — updateEvent implies the event is
  //   already there. (If you want upsert-or-create semantics instead, that's a
  //   different function — don't silently blur the two.)

  // TODO 8: merge — const updated = { ...existing, ...changes };
  //   Note this means `changes` fields win, everything else from `existing` is kept.
  //   `changes` should NOT be able to override `id` — decide how you want to guard
  //   that (e.g. `delete changes.id` before merging, or spread id last: `{ ...existing, ...changes, id }`).
  const updated = { ...existing, ...changes, id }; // Ensure id cannot be overridden by changes

  // TODO 9: putEvent(updated) to write the merged record back, then return it.
  await putEvent(updated);
  return updated; //returns item after update, dont need to fetch it .
}

// ─── cancelEvent(id) — thin wrapper over updateEvent for the common case ───────
export async function cancelEvent(id) {
  // when cancelled we later want to consider it as a soft delete
  const cancelledAt = new Date().toISOString(); // record WHEN it was cancelled
  return updateEvent(id, { status: "cancelled", cancelledAt });
}
