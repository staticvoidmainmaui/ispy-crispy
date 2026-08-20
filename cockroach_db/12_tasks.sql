-- ─── tasks ─── what is outstanding. i.e  "finish that doc", "PR is still open".
--
-- `state` is text, not an enum: it is only ever filtered, never switched on by the scorer.
-- The 01 enums exist because 16 does a CASE on them.

drop table if exists tasks cascade;

create table tasks (
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
  expires_at        timestamptz,
  created_at        timestamptz default now(),

  -- ── typed ──
  title           text not null,
  state           text not null default 'open',  -- open | doing | blocked | done | cancelled
  due_at          timestamptz,
  effort_minutes  int,                           -- what the planner fits into a block
  project         text,
  source          text default 'chat',
  external_id     text
);

create index idx_task_user_state_due on tasks (user_id, state, due_at);

-- Idempotent re-ingest. Partial — chat-created tasks have no external_id.
create unique index uq_task_external
  on tasks (user_id, source, external_id)
  where external_id is not null;

create vector index idx_task_embedding on tasks (embedding vector_cosine_ops);
create index idx_task_tags on tasks using gin (tags);
