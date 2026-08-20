-- ─── signals ─── what happened, from outside. To register a n8n / LangChain landing table.
--
-- Nothing in this repo fetches. A workflow normalizes and POSTs /ingest/signal.
-- `source` is free text so adding a workflow is a write, not a migration.

drop table if exists signals cascade;

create table signals (
  -- ── contract (10) ──
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null,
  content       text not null,
  embedding     vector(1024),
  importance    importance_level not null default 'medium',
  tags          text[]  default '{}',
  metadata      jsonb   default '{}',
  access_count      int         default 0,
  last_accessed_at  timestamptz,
  expires_at        timestamptz default now() + interval '30 days',  -- defaulted: a digest that never forgets is a landfill
  created_at        timestamptz default now(),

  -- ── typed ──
  source       text not null,   -- 'n8n:github' | 'n8n:gmail' | 'langchain:news'
  external_id  text not null,
  title        text,
  url          text,

  -- When it HAPPENED, not when we learned. 16 decays recency off this.
  occurred_at  timestamptz not null default now()
);

-- The ingest ON CONFLICT target — workflows replay.
create unique index uq_signal_external on signals (user_id, source, external_id);

-- "everything since midnight" — the digest scan.
create index idx_signal_user_occurred on signals (user_id, occurred_at desc);

create vector index idx_signal_embedding on signals (embedding vector_cosine_ops);
create index idx_signal_tags on signals using gin (tags);
