-- Record that these memories were just recalled adding a touch of freshness. The promotion signal's raw input.
-- $1 = ids (uuid[])
--
-- Called fire-and-forget from recall() — NOT awaited. A read path must never wait on
-- a write it doesn't need. One statement for the whole hit set (= any($1)).

update memories
set access_count     = access_count + 1,
    last_accessed_at = now()
where id = any($1::uuid[])
returning id, access_count;
