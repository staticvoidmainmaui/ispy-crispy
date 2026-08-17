-- Backfill expires_at on working rows. Dated from created_at, not now().
-- $1 = user_id (uuid)   $2 = ttl_hours (int)

update memories
set expires_at = created_at + ($2 || ' hours')::interval --Dated from created_at, not now() when check happens
where user_id = $1
  and memory_type = 'working'
  and expires_at is null
returning id, expires_at;
