-- Attach facet tags to one memory.
-- $1 = memory_id (uuid)   $2 = tags (text[])
--
-- Guarded on tags = '{}' so this only ever fills an EMPTY tag set. A pass can add tags
-- to an untagged row but never overwrite tags already there — hand-curated or
-- earlier-model tags survive a later run. Widening an existing set is a different
-- operation (array append) and should be a different statement when it's wanted.

update memories
set tags = $2::text[]
where id = $1
  and tags = '{}'
returning id, tags;
