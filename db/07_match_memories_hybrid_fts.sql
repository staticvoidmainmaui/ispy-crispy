-- ═══════════════════════════════════════════════════════════════════════════════════
-- Hybrid recall (step 1 of the arc) — dense + Postgres BUILT-IN full-text (ts_rank_cd),
-- fused by RRF, that fused signal used as RELEVANCE inside file 04's composite.
--
--   score     = 0.7·relevance + 0.3·recency + 0.1·importance
--   relevance = normalized RRF over the dense + FTS rankings
--   RRF(D)    = Σ_lists 1 / (rrf_k + rank_in_list)
--
-- content_tsv is a stored generated tsvector (01_memories.sql). ts_rank_cd gives the lexical
-- score; websearch_to_tsquery turns raw text into a safe query. Fill it in — I'll rate.
-- ═══════════════════════════════════════════════════════════════════════════════════

drop function if exists match_memories_hybrid_fts(vector, text, int, uuid, memory_type, int);

create or replace function match_memories_hybrid_fts(
  query_embedding vector(384),
  query_text      text,                   --added for full-text search
  match_count     int         default 3,
  p_user_id       uuid        default null,
  p_memory_type   memory_type default null,
  rrf_k           int         default 60  -- RRF smoothing constant
)
returns table (
  id          uuid,
  content     text,
  memory_type memory_type,
  relevance   float,
  recency     float,
  score       float
)
language sql stable
as $$

  -- candidate set: pre-filter once (user + type), carry what later steps need
  with filtered as (
    select 
     m.id,
     m.content,
     m.memory_type,
     m.embedding,
     m.content_tsv,
     m.created_at,
     m.importance
    from memories m
    where m.embedding is not null
      and (p_user_id     is null or m.user_id     = p_user_id)
      and (p_memory_type is null or m.memory_type = p_memory_type)
  ),

  -- tokenize the query once (reuse in the FTS step)
  q as (
    select websearch_to_tsquery('english', query_text) as query
    --confused on this one why tokenize if we have content_tsv from memories m
  ),

  -- dense half: cosine distance -> rank
  dense_ranked as (
    select
      f.id,
      rank() over (ORDER BY f.embedding <=> query_embedding) as dense_rank
    from filtered f
  ),

  -- sparse half: ts_rank_cd -> rank, matches only
  fts_ranked as (
    select
      f.id,
      rank() over (ORDER BY ts_rank_cd(f.content_tsv, q.query) DESC) as fts_rank -- can also fit normalization integer
      FROM filtered f , q  -- rank_cd against the query
      WHERE f.content_tsv @@ q.query
  ),
  --ts_rank_cd will happily score non-matches as 0, so the @@ filter is what keeps the sparse list to actual lexical hits.
 
  -- fuse: RRF over the two ranked lists (full outer join)
  -- RRF (Reciprocal Rank Fusion) formula: 1/(k + rank1) + 1/(k + rank2)
  fused as (
    select
      COALESCE(d.id, f.id) as id,
      d.dense_rank,
      f.fts_rank,
      -- RRF score
      COALESCE(1.0 / (rrf_k + d.dense_rank), 0) 
      + COALESCE(1.0 / (rrf_k + f.fts_rank), 0) AS rrf_score
      FROM fts_ranked 
      FULL OUTER JOIN dense_ranked d ON f.id = d.id
  ),

  -- normalize RRF -> relevance; compute recency + importance
  signals as (
    select
      f.id,
      f.memory_type,
      f.content,
      rrf_score / max(rrf_score) over () as relevance, --normalizing 0-1 since scores are tiny, 
      exp(-extract(epoch from (now() - f.created_at)) / (60 * 60 * 24 * 7)) as recency,  -- exponential decay
      case f.importance
        when 'critical' then 1.0
        when 'high'     then 0.75
        when 'medium'   then 0.5
        when 'low'      then 0.25
        else 0.0
      end as importance_score
    from filtered f,
     fused
    where f.id = fused.id
  )

  -- composite score, order, limit
  select
    f.id,
    f.content,
    f.memory_type,
    f.relevance,
    f.recency,
    0.7 * f.relevance + 0.3 * f.recency + 0.1 * f.importance_score as score
  FROM signals f
  ORDER BY score DESC
  LIMIT match_count
  ;
$$;
