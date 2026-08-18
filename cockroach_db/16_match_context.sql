-- ─── match_context ─── ranked recall, v4. One scorer, five kinds, one statement.
--
-- One statement = one implicit transaction = ONE CONSISTENT SNAPSHOT across kinds.
-- That is the claim: no more N queries against N separately-consistent stores.
--
-- 08 stays live and untouched; recall() keeps calling it until the eval clears the switch.
--
-- THREE CHANGES FROM 08:
--
--   1. Retrieve-per-kind, then fuse. Each kind gets its own `order by <=> limit p_per_kind`
--      — the shape a vector index can answer. Fusing first (15) has no index to use.
--
--   2. Relevance NORMALIZED across the pooled set. Raw `1 - distance` is fine within one
--      table; across kinds Titan's distance depends on row length, so a terse calendar row
--      and a long signal sit in different bands and row SHAPE outranks relevance.
--      `(1-d)/max(1-d) over ()` is the same trick 07 uses on RRF.
--      Side effect: this is the hypothesized fix for s3-inject-01 — recency was swamping a
--      compressed relevance spread. Stage A's cutover is therefore the Stage 6 gate.
--
--   3. Recency decays off a per-kind anchor, clamped. A calendar event's starts_at can be
--      in the FUTURE; exp(-negative) > 1 would score tomorrow's dentist at 4.0 on a 0-1
--      term. greatest(…,0) makes "not yet happened" maximally fresh.

drop function if exists match_context(vector, uuid, entity_kind[], memory_type, int, int, text[], timestamptz);

create or replace function match_context(
    query_embedding vector(1024),
    p_user_id       uuid,                          -- not nullable: 08's dev-only null across
                                                   -- five tables is cross-user leakage
    p_kinds         entity_kind[] default null,    -- null = every kind
    p_memory_type   memory_type   default null,    -- facet filter, MEMORIES BRANCH ONLY
    p_per_kind      int           default 5,       -- candidates per kind, pre-fusion
    match_count     int           default 8,       -- rows returned, post-fusion
    p_tags          text[]        default null,
    p_since         timestamptz   default null
)
returns table (
  kind             entity_kind,
  id               uuid,
  content          text,
  memory_type      memory_type,   -- null for every kind but 'memory'
  tags             text[],
  distance         float,   -- raw cosine, so the true neighbourhood stays visible
  relevance        float,   -- normalized 0-1 within this query
  recency          float,
  frequency        float,
  importance_score float,
  score            float
)
language sql stable
as $$
  with
  -- ── one bounded top-K per kind ──
  -- `(p_kinds is null or …)` is a constant predicate: an unrequested kind returns empty.
  mem as (
    select 'memory'::entity_kind as kind, m.id, m.content, m.memory_type, m.tags,
           (m.embedding <=> query_embedding) as distance,
           m.created_at as anchor_at, m.importance, m.access_count
    from memories m
    where (p_kinds is null or 'memory'::entity_kind = any(p_kinds))
      and m.user_id = p_user_id
      and m.embedding is not null
      -- Prefilter, not postfilter (docs/practices/pre-filtering.md). Applies to this
      -- branch only — the other kinds have no memory_type and must not be filtered out.
      and (p_memory_type is null or m.memory_type = p_memory_type)
      and m.metadata->>'superseded_by'     is null   -- supersede-never-delete: exists, but
      and m.metadata->>'consolidated_into' is null   -- no longer its own answer
      and (m.expires_at is null or m.expires_at > now())
      and (p_tags is null or m.tags && p_tags)
    order by m.embedding <=> query_embedding
    limit p_per_kind
  ),
  cal as (
    select 'calendar_event'::entity_kind, c.id, c.content, null::memory_type, c.tags,
           (c.embedding <=> query_embedding),
           c.starts_at, c.importance, c.access_count
    from calendar_events c
    where (p_kinds is null or 'calendar_event'::entity_kind = any(p_kinds))
      and c.user_id = p_user_id
      and c.embedding is not null
      and c.status <> 'cancelled'
      and (c.expires_at is null or c.expires_at > now())
      and (p_since is null or c.starts_at >= p_since)   -- planning reads FORWARD
      and (p_tags is null or c.tags && p_tags)
    order by c.embedding <=> query_embedding
    limit p_per_kind
  ),
  tsk as (
    select 'task'::entity_kind, t.id, t.content, null::memory_type, t.tags,
           (t.embedding <=> query_embedding),
           coalesce(t.due_at, t.created_at), t.importance, t.access_count
    from tasks t
    where (p_kinds is null or 'task'::entity_kind = any(p_kinds))
      and t.user_id = p_user_id
      and t.embedding is not null
      and t.state not in ('done', 'cancelled')
      and (t.expires_at is null or t.expires_at > now())
      and (p_tags is null or t.tags && p_tags)
    order by t.embedding <=> query_embedding
    limit p_per_kind
  ),
  sig as (
    select 'signal'::entity_kind, s.id, s.content, null::memory_type, s.tags,
           (s.embedding <=> query_embedding),
           s.occurred_at, s.importance, s.access_count
    from signals s
    where (p_kinds is null or 'signal'::entity_kind = any(p_kinds))
      and s.user_id = p_user_id
      and s.embedding is not null
      and (s.expires_at is null or s.expires_at > now())
      -- The only kind with a default window. Unbounded = newsletter = disqualified.
      and s.occurred_at >= coalesce(p_since, now() - interval '1 day')
      and (p_tags is null or s.tags && p_tags)
    order by s.embedding <=> query_embedding
    limit p_per_kind
  ),
  ofr as (
    select 'offer'::entity_kind, o.id, o.content, null::memory_type, o.tags,
           (o.embedding <=> query_embedding),
           o.created_at, o.importance, o.access_count
    from offers o
    where (p_kinds is null or 'offer'::entity_kind = any(p_kinds))
      and o.user_id = p_user_id
      and o.embedding is not null
      and o.in_stock
      and (o.expires_at is null or o.expires_at > now())
      and (p_tags is null or o.tags && p_tags)
    order by o.embedding <=> query_embedding
    limit p_per_kind
  ),

  pooled as (
    select * from mem
    union all select * from cal
    union all select * from tsk
    union all select * from sig
    union all select * from ofr
  ),

  -- ── signals ──
  scored as (
    select
      p.kind, p.id, p.content, p.memory_type, p.tags, p.distance,

      -- change 2. nullif guards the best candidate sitting at distance exactly 1.0.
      (1.0::float8 - p.distance) / nullif(max(1.0::float8 - p.distance) over (), 0)
        as relevance,

      -- change 3. tau 604800.0 = 1 week, inlined to match 08 — tune both or neither.
      exp(-greatest(extract(epoch from (now() - p.anchor_at)), 0.0) / 604800.0)
        as recency,

      case p.importance
        when 'critical' then 1.0::float8
        when 'high'     then 0.75::float8
        when 'medium'   then 0.5::float8
        when 'low'      then 0.25::float8
        else 0.0::float8
      end as importance_score,

      1.0::float8 - exp(-(p.access_count::float8) / 5.0::float8) as frequency
    from pooled p
  )

  -- ── composite ──
  -- Weights unchanged from 08 on purpose: changing normalization AND weights in one
  -- migration makes the eval delta unattributable, and Stage 6 blocks on unexplained drops.
  select
    s.kind, s.id, s.content, s.memory_type, s.tags, s.distance,
    s.relevance, s.recency, s.frequency, s.importance_score,
    0.7::float8 * s.relevance
      + 0.3::float8 * s.recency
      + 0.1::float8 * s.importance_score
      + 0.1::float8 * s.frequency
      as score
  from scored s
  order by score desc
  limit match_count;
$$;
