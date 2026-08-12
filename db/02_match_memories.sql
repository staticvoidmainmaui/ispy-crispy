-- Phase 0/2 — the recall function your `recall.js` calls via supabase.rpc("match_memories").
-- Start pure-vector (semantic only). We add the full-text `content_tsv` rank to make it a
-- true HYBRID search in Phase 2 — for now, nearest-vector is enough to see recall work.
--
-- `<=>` is pgvector's cosine-DISTANCE operator: smaller = more similar. So ORDER BY it ASC
-- and the closest rows come first. This is the entire "similarity search" — one indexed query.

create or replace function match_memories(
  query_embedding vector(384),
  match_count     int  default 3,
  p_user_id       uuid default null      -- pass a user id to scope; null = search everything (dev only)
)
returns table (
  id          uuid,
  content     text,
  memory_type memory_type,
  distance    float
)
language sql stable
as $$
  select
    m.id,
    m.content,
    m.memory_type,
    (m.embedding <=> query_embedding) as distance
  from memories m
  where m.embedding is not null
    and (p_user_id is null or m.user_id = p_user_id)
  order by m.embedding <=> query_embedding
  limit match_count;
$$;
