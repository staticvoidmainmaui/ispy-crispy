-- ───  plain vector match ─── ported to CockroachDB.
-- Source: postgres_db/02_match_memories.sql
-- ─── ─── ─── ─── ─── ─── ─── 
--
drop function if exists match_memories(vector, int, uuid);

create or replace function match_memories(
  query_embedding vector(1024),
  match_count     int  default 3,
  p_user_id       uuid default null
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
