-- ─── Substrate  ─── ported to CockroachDB.
-- Source: postgres_db/01_memories.sql (Supabase/pgvector). Read them side by side; the
-- diff IS the port story.
--
-- Verified against CockroachDB Cloud Basic v26.2.5 via scripts/probe-crdb-schema.mjs.
-- Every construct below was probed on the live cluster, not inferred from docs.

-- ─────────────────────────────────────────────────────────────────────────────
-- CHANGE 1 — no extensions.
-- Postgres needed `create extension vector` (pgvector) and `pgcrypto` (sha256 +
-- gen_random_uuid). CockroachDB has the VECTOR type, sha256(), and gen_random_uuid()
-- built in. There is no extension system to opt into, so both lines are deleted rather
-- than translated.
-- ─────────────────────────────────────────────────────────────────────────────

drop table if exists memories cascade;
drop type  if exists memory_type;
drop type  if exists importance_level;

-- Unchanged from Postgres. Enums port verbatim.
create type memory_type      as enum ('episodic','semantic','procedural','working','consolidated');
create type importance_level as enum ('critical','high','medium','low','trivial');

create table memories (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null,                          -- per-user isolation

  content       text not null,

  -- CHANGE 2 — the content_hash expression.

  -- GENERATED columns: derived from content by CRDB to never drift out of sync.
  content_hash  text     generated always as (sha256(content))                 stored,
  content_tsv   tsvector generated always as (to_tsvector('english', content)) stored,

  memory_type   memory_type      not null default 'episodic',
  importance    importance_level not null default 'medium',
  tags          text[]  default '{}',
  metadata      jsonb   default '{}',

  -- CHANGE 3 — vector dimension: 384 -> 1024.
  embedding     vector(1024),

  access_count      int         default 0,
  last_accessed_at  timestamptz,
  expires_at        timestamptz,                        -- NULL = lives forever
  created_at        timestamptz default now()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- CHANGE 4 — the vector index.
-- The pgvector tuning knobs (m, ef_construction) have no equivalent — dropped
--
-- vector_cosine_ops is stated EXPLICITLY and is not optional: the default opclass is
-- L2, and recall() ranks with the `<=>` cosine operator.
-- ─────────────────────────────────────────────────────────────────────────────
create vector index idx_memories_embedding on memories (embedding vector_cosine_ops);

-- Lexical half of hybrid search + common filters.
create index idx_memories_tsv  on memories using gin (content_tsv);
create index idx_memories_tags on memories using gin (tags);
create index idx_memories_user on memories (user_id);
