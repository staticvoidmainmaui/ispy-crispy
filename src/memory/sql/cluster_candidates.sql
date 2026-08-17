-- Near-duplicate edges (restatements). Node groups these into clusters via union-find.
-- Sibling of contradiction_candidates.sql: that one finds CONFLICTS, this finds RESTATEMENTS.
-- $1 = user_id (uuid)   $2 = max_distance (float)   $3 = limit (int)

select
  a.id      as a_id,
  a.content as a_content,
  b.id      as b_id,
  b.content as b_content,
  (a.embedding <=> b.embedding) as distance

from memories a
join memories b
  on  a.user_id = b.user_id
 and a.created_at < b.created_at
 and (a.embedding <=> b.embedding) < $2

where a.user_id = $1
  and a.memory_type = 'semantic'
  and b.memory_type = 'semantic'

  -- Skip anything already resolved by a previous pass, in either direction.
  and a.metadata->>'superseded_by' is null
  and b.metadata->>'superseded_by' is null
  and a.metadata->>'consolidated_into' is null
  and b.metadata->>'consolidated_into' is null

order by distance asc
limit $3;
