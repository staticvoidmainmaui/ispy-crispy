// Stage 1 — the CockroachDB connection. This is the FIRST file of the port.
//
// CockroachDB is : 
// plain Postgres over the wire, so all HTTP , TLS , and query building are in this one thing a 
// connection pool you send SQL to. This module is that pool, and it follows the SAME module-level
// singleton pattern as src/events/dynamoClient.mjs:37 — construct once, import everywhere.
//
// Docs to read before filling in the TODOs:
//   - node-postgres pooling (why Pool and not Client):
//     https://node-postgres.com/features/pooling
//   - node-postgres connection config (ssl, connectionString):
//     https://node-postgres.com/apis/pool
//   - CockroachDB Cloud connection params:
//     https://www.cockroachlabs.com/docs/cockroachcloud/connect-to-your-cluster

import pg from "pg";


const { Pool } = pg;
const connectionString = process.env.DATABASE_URL ?? (() => { throw new Error("DATABASE_URL is not defined"); })();

export const pool = new Pool({
    connectionString,
  // ssl: { rejectUnauthorized: true }, // optional, see above
  // max: 10, // optional, see above
});

pool.on("error", (err, client) => {
    console.error("pool() : Unexpected ERROR on idle client", err);
});

// Exported QUuery function: a thin wrapper over pool.query() that adds timing.
// pool keeps its own untouched .query().
export async function query(text, params) {
  const start = Date.now();
  try {
    const res = await pool.query(text, params);
    console.log(`[db] ${Date.now() - start}ms rows=${res.rowCount}`);
    return res;
  } catch (err) {
    // Label by subsystem, per the convention in handleMessage.mjs:331.
    console.error(`[db] QUERY failed after ${Date.now() - start}ms:`, err.message);
    throw err;  // re-throw — the caller decides the response, same as recall.mjs
  }
}
