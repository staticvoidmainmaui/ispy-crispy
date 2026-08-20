-- ─── The citation query ─── what makes "matters to me" memory-defined.
--
-- "What happened today that matters to me" cannot rank against the QUESTION — that
-- sentence is semantically empty and would rank everything equally. It ranks against the
-- USER'S MEMORY SET: for each of today's signals, the nearest thing the user ever told us.
--
-- Two demo bars fall out of the shape rather than out of the prompt:
--   - an item with no memory inside the gate is EXCLUDED, so "zero uncited items" cannot
--     be violated by a model that forgot to cite
--   - the skip count is (total considered - rows returned), a number this query computed
--
-- $1 user_id  $2 since  $3 gate (max cosine distance)  $4 limit

select s.id, s.title, s.content, s.url, s.source, s.occurred_at,
       cited.id      as cited_memory_id,
       cited.content as citation,
       (s.embedding <=> cited.embedding) as affinity
from signals s
cross join lateral (
  select m.id, m.content, m.embedding
  from memories m
  where m.user_id = s.user_id
    and m.embedding is not null
    and m.metadata->>'superseded_by' is null
  order by m.embedding <=> s.embedding
  limit 1
) cited
where s.user_id = $1::uuid
  and s.occurred_at >= $2::timestamptz
  and (s.expires_at is null or s.expires_at > now())
  and (s.embedding <=> cited.embedding) < $3::float8
order by affinity asc
limit $4;
