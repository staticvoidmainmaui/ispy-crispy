// Stage 1 done-when check: prove Node can reach the CockroachDB Cloud cluster.
//
// Run:  node --env-file=.env scripts/smoke-crdb.mjs
//
// This asks the cluster four questions that each fail in a DIFFERENT way, so a failure
// tells you WHICH layer broke instead of just "it didn't work":
//   1. SELECT 1        -> the socket + TLS + auth handshake all completed
//   2. version()       -> we're talking to CockroachDB, not a stray Postgres
//   3. current_*       -> which database/user we actually landed in
//   4. now()           -> the server clock, which the recency half of the composite
//                         score (db/04:76) depends on being sane

import { pool } from "../src/db/pool.mjs";

try {
  const { rows } = await pool.query(`
    select
      1                  as one,
      version()          as version,
      current_database() as db,
      current_user       as user,
      now()              as server_time
  `);

  const r = rows[0];
  console.log("SUCCESS : connected to CockroachDB\n");
  console.log(`  one          ${r.one}`);
  console.log(`  version      ${r.version}`);
  console.log(`  database     ${r.db}`);
  console.log(`  user         ${r.user}`);
  console.log(`  server_time  ${r.server_time.toISOString()}`);
  console.log(`  clock skew   ${Math.abs(Date.now() - r.server_time.getTime())}ms vs local`);
} catch (err) {
  // Label the failure by subsystem, per the convention in handleMessage.mjs:331.
  console.error("ERR : CONNECTION failed (pg/CockroachDB Cloud):", err.message);
  console.error("\n   code:", err.code ?? "(none)");
  console.error(`
   Reading the error:
     ENOTFOUND / EAI_AGAIN  -> hostname wrong, or an unencoded special char in the
                               password broke URL parsing (@ must be %40)
     ETIMEDOUT / hangs      -> IP allowlist, not your code (see --skip-ip-check)
     28P01 / password auth  -> wrong password; the string itself parsed fine
     SELF_SIGNED_CERT/TLS   -> ssl config in pool.mjs. Fix it properly; do NOT
                               reach for rejectUnauthorized:false
     "connectionString is undefined" -> TODO 1 in pool.mjs, or .env not loaded
                               (did you use --env-file?)
  `);
  process.exitCode = 1;
} finally {
  // Pool keeps the event loop alive; without this the script hangs after printing.
  await pool.end();
}
