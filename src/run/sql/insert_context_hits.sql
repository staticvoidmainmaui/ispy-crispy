-- Bulk insert what the scorer returned, signals included.
-- $1 run_id   $2 jsonb array of { rank, kind, entity_id, distance, relevance, recency, frequency, score }

insert into context_hits (run_id, rank, kind, entity_id, distance, relevance, recency, frequency, score)
select $1::uuid,
       (e->>'rank')::int,
       (e->>'kind')::entity_kind,
       (e->>'entity_id')::uuid,
       (e->>'distance')::float8,
       (e->>'relevance')::float8,
       (e->>'recency')::float8,
       (e->>'frequency')::float8,
       (e->>'score')::float8
from jsonb_array_elements($2::jsonb) as e
returning rank;
