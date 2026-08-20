// config.mjs
// Supabase exports removed with the port; DATABASE_URL is read at its point of use in
// db/pool.mjs, and INGEST_TOKEN in ingest/receive.mjs.
export const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

export const DEV_USER = "00000000-0000-0000-0000-000000000001";
