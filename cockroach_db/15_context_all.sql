-- ─── context_all ─── the contract, made executable.
--
-- A kind that drifts from 10 fails HERE, at create time, on a type mismatch.
--
-- NOT THE READ PATH. `select * from context_all order by embedding <=> $1` is a full scan
-- of five tables — a vector index answers ORDER BY/LIMIT against ONE table, and a UNION
-- has none. 16 bounds each kind first, then fuses. This view is for introspection,
-- reflection, and the eval.
--
-- Column order is contract order, so `union all` matches positionally.

create or replace view context_all as
    select 'memory'::entity_kind as kind,
           id, user_id, content, embedding, importance, tags, metadata,
           access_count, last_accessed_at, expires_at, created_at,
           created_at as anchor_at        -- per-kind time anchor; see 16
      from memories
  union all
    select 'calendar_event'::entity_kind,
           id, user_id, content, embedding, importance, tags, metadata,
           access_count, last_accessed_at, expires_at, created_at,
           starts_at
      from calendar_events
  union all
    select 'task'::entity_kind,
           id, user_id, content, embedding, importance, tags, metadata,
           access_count, last_accessed_at, expires_at, created_at,
           coalesce(due_at, created_at)
      from tasks
  union all
    select 'signal'::entity_kind,
           id, user_id, content, embedding, importance, tags, metadata,
           access_count, last_accessed_at, expires_at, created_at,
           occurred_at
      from signals
  union all
    select 'offer'::entity_kind,
           id, user_id, content, embedding, importance, tags, metadata,
           access_count, last_accessed_at, expires_at, created_at,
           created_at
      from offers;
