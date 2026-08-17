-- Edges of the near-duplicate graph: pairs of a user's semantic memories close enough
-- in vector space to be saying the same thing. Node assembles these into clusters.
-- $1 = user_id (uuid)   $2 = max_distance (float)   $3 = limit (int)
--
-- Sibling of contradiction_candidates.sql, and the distinction is the whole point:
--   contradiction -> two memories that CONFLICT   ("I love mornings" / "I hate mornings")
--   cluster       -> two memories that RESTATE    ("I like Thai" / "Thai food is my favorite")
-- Restatement is the case the contradiction judge is explicitly told to pass on, so
-- those pairs would otherwise accumulate forever. Same neighbourhood, tighter radius.
--
-- This returns EDGES, not clusters. Single-linkage grouping happens in Node (union-find):
-- transitive closure is awkward in SQL, and this is a nightly batch job, not a ranking
-- query — pattern #8 puts RANKING in SQL, it doesn't put every algorithm there.
--
-- Both directions are not returned: a.created_at < b.created_at fixes each edge once.

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
