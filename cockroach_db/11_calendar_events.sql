-- ─── calendar_events ─── Main retirement retirement for  DynamoDB.
--
-- Before utilized, putEvent() -> Dynamo `events` + writeMemory() -> `memories`, joined by a shared
-- UUID, no transaction. A throw between them orphans one side and nothing compensates.
-- One table, one row, both failure modes unrepresentable.
--
-- Retires (shared-id dual write) and #2 (enrichment degrades) - Retrieval Techniques for fuzzy match + ground truth

drop table if exists calendar_events cascade;

create table calendar_events (
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
  title       text not null,
  starts_at   timestamptz not null,
  ends_at     timestamptz,
  location    text,
  place_lat   float8,       -- cached geocode: one tool call instead of one per re-plan
  place_lon   float8,
  status      text not null default 'scheduled',   -- scheduled | tentative | cancelled
  source      text default 'chat'                  -- chat | proposal | n8n:<workflow>
);

-- Range scans — get_calendar's whole job.
create index idx_cal_user_starts on calendar_events (user_id, starts_at);

-- vector_cosine_ops mandatory: default opclass is L2, ranking uses `<=>`.
create vector index idx_cal_embedding on calendar_events (embedding vector_cosine_ops);
create index idx_cal_tags on calendar_events using gin (tags);
