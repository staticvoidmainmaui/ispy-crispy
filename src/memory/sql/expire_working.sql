-- Give working memories an expiry date. Backfill only.
-- $1 = user_id (uuid)   $2 = ttl_hours (int)
--
-- New working rows get expires_at at WRITE time (the tool loop sets it when it caches a
-- weather reading). This exists for the rows that predate that, and as a safety net for
-- any writer that forgets — a working memory with no expiry is a leak, because 08 treats
-- NULL as never-expires and it would sit in the candidate set forever.
--

update memories
set expires_at = created_at + ($2 || ' hours')::interval --Dated from created_at, not now() when check happens
where user_id = $1
  and memory_type = 'working'
  and expires_at is null
returning id, expires_at;
