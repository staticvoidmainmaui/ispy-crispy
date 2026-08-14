-- ─── Ranked recall ───  composite scoring instead of pure nearest-vector. 
-- This upgrades similarity search to the agent-memory retrieval model — Park et al., "Generative Agents" (2023):
--
-- | score = α·relevance + β·recency (+ γ·importance)
 
-- ... and adds a OPTIONAL memory_type filter for prefiltering before ranking
-- ─── ─── ────── ─── ─── 

drop function if exists match_memories(vector, int, uuid);

create or replace function match_memories( 
    query_embedding vector(1024),
    match_count     int         default 3,
    p_user_id       uuid        default null, -- null = all users (dev only)
    p_memory_type   memory_type default null
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
      (m.embedding <=> query_embedding) as distance,
      m.created_at,
      m.importance
    from memories m
    where m.embedding is not null
      and (p_user_id     is null or m.user_id     = p_user_id)
      and (p_memory_type is null or m.memory_type = p_memory_type) -- prefilter fires if not short circuit on specified recall
  ),
  signals as (
    select
      f.id,
      f.content,
      f.memory_type,
      f.distance,
      1 - f.distance as relevance,
      -- tau is inlined as 60 * 60 * 24 * 7 = 604800.0=> 1 week for decay - tune here
      exp(-extract(epoch from (now() - f.created_at)) / 604800.0) as recency,
      case f.importance
        when 'critical' then 1.0::float8
        when 'high'     then 0.75::float8
        when 'medium'   then 0.5::float8
        when 'low'      then 0.25::float8
        else 0.0::float8
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
      0.7::float8 * s.relevance + 0.3::float8 * s.recency + 0.1::float8 * s.importance_score as composite_score
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
  order by composite_score DESC        
  limit match_count;
$$;
