-- Bump recall counters. Fire-and-forget from recall(), not awaited.
-- $1 = ids (uuid[])

update memories
set access_count     = access_count + 1,
    last_accessed_at = now()
where id = any($1::uuid[])
returning id, access_count;
