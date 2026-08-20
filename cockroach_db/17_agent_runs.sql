-- ─── The agent run ledger ─── one atomic, auditable unit per agent task.
--
-- `trace` in handleMessage lives for one request and is discarded unless ?debug=1.
-- Four tables, FK-related in one cluster, replace a request-id threaded through five
-- modules by hand.
--
--   agent_runs                    one row per turn
--     ├─ context_hits             what was recalled, with scores
--     ├─ tool_calls               what ran, with arguments
--     └─ proposed_actions         what the agent WANTS to do
--
-- WHY proposed_actions IS A TABLE, NOT A FLAG ON calendar_events:
-- a `pending` column satisfies "zero writes before approval" in prose and violates it in
-- fact — the row is already written. A separate table makes it an invariant:
--   no tool can write calendar_events; only POST /actions/:id/approve can.
-- Then the claim is a count(*), not a screenshot.

drop table if exists proposed_actions cascade;
drop table if exists context_hits     cascade;
drop table if exists tool_calls       cascade;
drop table if exists agent_runs       cascade;
drop type  if exists action_status;
drop type  if exists run_status;

create type run_status    as enum ('running', 'ok', 'error', 'timeout');
create type action_status as enum ('pending', 'approved', 'rejected', 'applied', 'expired');

-- ─── agent_runs ── the unit ──────────────────────────────────────────────────
create table agent_runs (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null,
  user_message  text not null,
  intent        text,

  -- 'running' at turn start so SSE has a run_id immediately, done after the stream ends.
  status        run_status not null default 'running',

  model         text,
  latency_ms    int,
  tokens_in     int,
  tokens_out    int,
  error         text,                      -- the failure DOMAIN, per pattern #3

  started_at    timestamptz default now(),
  finished_at   timestamptz,
  expires_at    timestamptz default now() + interval '30 days'
);

create index idx_run_user_started on agent_runs (user_id, started_at desc);

-- ─── tool_calls ── what ran ──────────────────────────────────────────────────
-- Answers "≥4 tools" with a number.
create table tool_calls (
  id          uuid primary key default gen_random_uuid(),
  run_id      uuid not null references agent_runs(id) on delete cascade,

  seq         int not null,   -- chain order within the run
  iteration   int not null,   -- same iteration = ran CONCURRENTLY

  tool_name   text not null,
  input       jsonb,          -- the argument is the proof the memory was load-bearing
  output      jsonb,
  ok          bool not null,
  error       text,
  latency_ms  int,
  started_at  timestamptz default now(),

  unique (run_id, seq)
);

-- ─── context_hits ── what was recalled ───────────────────────────────────────
-- Signals stored, not just ids: "watch the old memory grey out" is a diff of two runs'
-- hits, and a diff needs the scores that produced the order.
-- No FK — it points at five tables, and a superseded row must stay citable.
create table context_hits (
  run_id      uuid not null references agent_runs(id) on delete cascade,
  rank        int  not null,                -- 0-based, scorer order
  kind        entity_kind not null,
  entity_id   uuid not null,
  distance    float,
  relevance   float,
  recency     float,
  frequency   float,
  score       float,

  primary key (run_id, rank)
);

-- ─── proposed_actions ── what the agent wants to do ──────────────────────────
create table proposed_actions (
  id           uuid primary key default gen_random_uuid(),
  run_id       uuid not null references agent_runs(id) on delete cascade,
  user_id      uuid not null,               -- denormalized: "my pending actions" skips the join

  action       text not null,               -- create_event | move_event | cancel_event | open_cart
  target_kind  entity_kind,
  target_id    uuid,                        -- null for create_*

  payload      jsonb not null,              -- the mutation, exactly as it will be applied
  rationale    text,                        -- "you told me afternoons work better now"

  status       action_status not null default 'pending',
  decided_at   timestamptz,
  applied_at   timestamptz,
  created_at   timestamptz default now(),
  expires_at   timestamptz default now() + interval '7 days'
);

create index idx_action_user_status on proposed_actions (user_id, status, created_at desc);
