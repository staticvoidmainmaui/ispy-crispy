-- ─── Ranked recall, v3 ─── the read side of reflection-as-maintenance.
--
-- 04 gave us composite scoring. It ranks well but it cannot SEE any of the work the
-- upgraded ReflectAgent does: a promoted memory ranks the same as a never-recalled one,
-- an expired working memory still surfaces, and a merged-away duplicate still competes
-- with the summary that replaced it. This is the read half that makes those writes matter.
--
-- Four changes, all of them turning a dead column into a live one:
--   1. expires_at   -> working memories drop out the moment they lapse
--   2. metadata.consolidated_into -> members hidden once a summary replaces them
--   3. access_count -> a frequency term in the score (promotion, per-query half)
--   4. tags         -> optional facet filter (the GIN index has existed since 01, unread)
--
-- Ranking stays in SQL and Node stays a consumer of ordered rows (pattern #8).
--
-- NOTE ON REPLACE: `create or replace` CANNOT change a function's return type, and we are
-- adding two columns to the returns table. The drop is mandatory, not tidiness.
-- Verified against the live cluster: exactly ONE signature exists today.

drop function if exists match_memories(vector, int, uuid, memory_type);

create or replace function match_memories(
    query_embedding vector(1024),
    match_count     int         default 3,
    p_user_id       uuid        default null, -- null = all users (dev only)
    p_memory_type   memory_type default null,
    p_tags          text[]      default null  -- null = no facet filter — unused by chat today
)
returns table (
  id          uuid,
  content     text,
  memory_type memory_type,
  tags        text[],  -- NEW: returned so a caller can show WHY a row matched a facet
  distance    float,
  recency     float,   -- exposed on purpose: so you can SEE why a row ranked where it did
  frequency   float,   -- NEW: same reason — the promotion signal, visible not hidden
  score       float
)
language sql stable
as $$
  with filtered as (
    select
      m.id,
      m.content,
      m.memory_type,
      m.tags,
      (m.embedding <=> query_embedding) as distance,
      m.created_at,
      m.importance,
      m.access_count
    from memories m
    where m.embedding is not null
      and (p_user_id     is null or m.user_id     = p_user_id)
      and (p_memory_type is null or m.memory_type = p_memory_type) -- prefilter fires if not short circuit on specified recall
      and m.metadata->>'superseded_by' is null -- dont recall superseded rows
      -- Expiry. NULL means "never expires", which is every durable memory, so this
      -- clause is a no-op for semantic/episodic and only ever bites working rows.
      and (m.expires_at is null or m.expires_at > now())
      -- Consolidation. A member that has been merged into a summary is not deleted
      -- (supersede-never-delete holds) — it is simply no longer its own answer.
      and m.metadata->>'consolidated_into' is null
      -- Facet filter. `&&` is array overlap: keep rows sharing ANY requested tag.
      -- Reads the idx_memories_tags GIN index that has existed since 01 with no reader.
      and (p_tags is null or m.tags && p_tags)
  ),
  signals as (
    select
      f.id,
      f.content,
      f.memory_type,
      f.tags,
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
      end as importance_score,
      1.0::float8 - exp(-(f.access_count::float8) / 5.0::float8) as frequency --saturating curve bounded 0->1 , tau of 5 = first few recalls move the needle most
    from filtered f
  ),
  composite as (
    select
      s.id,
      s.content,
      s.memory_type,
      s.tags,
      s.distance,
      s.recency,
      s.frequency,
      0.7::float8 * s.relevance
        + 0.3::float8 * s.recency
        + 0.1::float8 * s.importance_score
        + 0.1::float8 * s.frequency   --same weight as importance. 
        as composite_score
    from signals s
  )
  select
    c.id,
    c.content,
    c.memory_type,
    c.tags,
    c.distance,
    c.recency,
    c.frequency,
    c.composite_score
  from composite c
  order by composite_score DESC
  limit match_count;
$$;
