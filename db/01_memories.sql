-- Phase 0 — Substrate: the typed `memories` table.
-- Run this in the Supabase SQL editor. This REPLACES your minimal test table.
-- Your old table only had (text, embedding); test data is throwaway, so we drop + recreate.
--
-- The whole memory layer IS this one table. Everything else (writeMemory, recall,
-- consolidation) just reads/writes rows here. Read it top-to-bottom once — every column
-- earns its place.

create extension if not exists vector;
create extension if not exists pgcrypto;   -- for sha256() + gen_random_uuid()

-- Drop old test artifacts so we can redeclare cleanly.
drop table if exists memories cascade;
drop type  if exists memory_type;
drop type  if exists importance_level;

-- The label your CODE decides (pgvector does NOT set this). episodic = "a thing that
-- happened"; semantic = "a durable fact about the user". The rest come later.
create type memory_type      as enum ('episodic','semantic','procedural','working','consolidated');
create type importance_level as enum ('critical','high','medium','low','trivial');

create table memories (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null,                          -- per-user isolation (Phase 5 leans on this)

  content       text not null,                          -- the memory text itself

  -- GENERATED columns: derived from content by Postgres, can never drift out of sync.
  content_hash  text     generated always as (encode(sha256(content::bytea), 'hex')) stored,   -- dedup key
  content_tsv   tsvector generated always as (to_tsvector('english', content))        stored,   -- full-text half of hybrid search

  memory_type   memory_type      not null default 'episodic',
  importance    importance_level not null default 'medium',
  tags          text[]  default '{}',
  metadata      jsonb   default '{}',

  embedding     vector(384),                            -- the ONLY non-generated derived col: needs the model, so it's async

  access_count      int         default 0,              -- recency signals (Phase 5 tuning)
  last_accessed_at  timestamptz,
  expires_at        timestamptz,                        -- NULL = lives forever (this is the "outlives 24h TTL" trick)
  created_at        timestamptz default now()
);

-- Vector-from-the-start: declare the ANN index NOW, not after a painful backfill.
create index idx_memories_embedding on memories using hnsw (embedding vector_cosine_ops)
  with (m = 16, ef_construction = 64);

-- Lexical half of hybrid search + common filters.
create index idx_memories_tsv  on memories using gin (content_tsv);
create index idx_memories_tags on memories using gin (tags);
create index idx_memories_user on memories (user_id);
