-- ─── The recallable contract ─── generalizes 01's shape past `memories`.
--
-- CONTRACT — copy verbatim into every recallable table. 15 unions on it, 16 ranks on it.
--
--   id                uuid primary key default gen_random_uuid(),
--   user_id           uuid not null,
--   content           text not null,                  -- the embedded surface
--   embedding         vector(1024),
--   importance        importance_level not null default 'medium',
--   tags              text[]      default '{}',
--   metadata          jsonb       default '{}',
--   access_count      int         default 0,
--   last_accessed_at  timestamptz,
--   expires_at        timestamptz,                    -- NULL = forever
--   created_at        timestamptz default now()
--
-- Typed columns filter and render. `content` is the only thing embedded.
-- `memories` already satisfies this — no ALTER.

drop type if exists entity_kind;

create type entity_kind as enum (
  'memory',          -- 01 — what the user told us
  'calendar_event',  -- 11 — what is scheduled
  'task',            -- 12 — what is outstanding
  'signal',          -- 13 — what happened, from outside
  'offer'            -- 14 — what can be bought
);
