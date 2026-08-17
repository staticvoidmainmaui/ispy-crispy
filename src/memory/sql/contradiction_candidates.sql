-- Pairs of a user's semantic memories that are near-duplicates in vector space.
-- $1 = user_id (uuid)   $2 = max_distance (float)   $3 = limit (int)

select
  a.id      as older_id,
  a.content as older,
  a.created_at as older_at,
  b.id      as newer_id,
  b.content as newer,
  b.created_at as newer_at,
  (a.embedding <=> b.embedding) as distance

from memories a
join memories b
  on  a.user_id = b.user_id
 and a.created_at < b.created_at -- order by created_at
 and (a.embedding <=> b.embedding) < $2 --similarity matching

where a.user_id = $1
  -- only semantic (preferences) not events (episodic)
  and a.memory_type = 'semantic'
  and b.memory_type = 'semantic'

  -- check metadata for resolved matches if already marked superseded as well as consolidated.
  and a.metadata->>'superseded_by' is null -- ->> extracts text val
  and b.metadata->>'superseded_by' is null
  and a.metadata->>'consolidated_into' is null
  and b.metadata->>'consolidated_into' is null
order by distance asc
limit $3;
-- caps how many pairs come back in one call. 
-- ? - what if it gets pushed past the limit on a given run , a chain could sit unmarked for cycle
-- see how to architect later to converge on a chain or eventual convergence
