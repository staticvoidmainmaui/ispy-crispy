-- Attach facet tags. Only fills an EMPTY tag set, never overwrites.
-- $1 = memory_id (uuid)   $2 = tags (text[])

update memories
set tags = $2::text[]
where id = $1
  and tags = '{}'
returning id, tags;
