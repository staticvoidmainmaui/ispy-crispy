-- Phase 5 — Ranked recall: composite scoring instead of pure nearest-vector.
--
-- 02_match_memories.sql ranks by ONE signal: cosine distance (aboutness). This upgrades
-- it to the agent-memory retrieval model — Park et al., "Generative Agents" (2023):
--
--     score = α·relevance + β·recency (+ γ·importance)
--
-- ...and adds an OPTIONAL memory_type filter (pre-filtering: constrain the candidate set
-- BEFORE ranking, so "give me preferences" never even considers episodic rows).
--
-- Run this in the Supabase SQL editor AFTER 01 + 02. It replaces the match_memories
-- function. Keep 02 around as the baseline you can eyeball against.

-- The return TABLE gains columns (recency, score), and Postgres will NOT let
-- create-or-replace change a function's return shape — so drop the old signature first.
drop function if exists match_memories(vector, int, uuid);

create or replace function match_memories(
  query_embedding vector(384),
  match_count     int         default 3,
  p_user_id       uuid        default null,   -- null = all users (dev only)
  p_memory_type   memory_type default null    -- TODO 1: optional pre-filter; null = all types
)
returns table (
  id          uuid,
  content     text,
  memory_type memory_type,
  distance    float,
  recency     float,   -- exposed on purpose: so you can SEE why a row ranked where it did
  score       float
)
language sql stable
as $$
  with filtered as (
    select
      m.id,
      m.content,
      m.memory_type,
      (m.embedding <=> query_embedding) as distance,   -- cosine distance: LOWER = closer
      m.created_at,
      m.importance
    from memories m
    where m.embedding is not null
      and (p_user_id is null or m.user_id = p_user_id)
      and (p_memory_type is null or m.memory_type = p_memory_type)  -- TODO 1: optional pre-filter
      -- TODO 1: apply the optional type filter HERE, in the WHERE. This is pre-filtering:
      --   the candidate set is narrowed before scoring/limit, so a "semantic only" recall
      --   never wastes ranking budget on episodic rows. One line:
      --     and (p_memory_type is null or m.memory_type = p_memory_type)
  ), 
  signals as (
    select 
      f.id,
      f.content,
      f.memory_type,
      f.distance,
      1 - f.distance as relevance,  -- convert distance to a "higher = better" relevance score
      --60 * 60 * 24 * 7 as tau, - cannot reference in same select so we inline it. MAYBE make paramter for agent tuning later.
      exp(-extract(epoch from (now() - f.created_at)) / (60 * 60 * 24 * 7)) as recency,  -- exponential decay
      case f.importance
        when 'critical' then 1.0
        when 'high'     then 0.75
        when 'medium'   then 0.5
        when 'low'      then 0.25
        else 0.0
      end as importance_score
      from filtered f
  ),
  composite as (
    select
      s.id,
      s.content,
      s.memory_type,
      s.distance,
      s.recency,
      0.7 * s.relevance + 0.3 * s.recency + 0.1 * s.importance_score as composite_score
    from signals s
  )
  select
    c.id,
    c.content,
    c.memory_type,
    c.distance,
    c.recency,
    c.composite_score
  from composite c
  -- TODO 4: order by the COMPOSITE score DESC (best first) — NOT raw distance — then limit.
  --   (You'll need to repeat the score expression here, or wrap this select in another CTE
  --    so you can order by the alias. Decide which reads cleaner.)
  order by composite_score DESC        
  limit match_count;
$$;
