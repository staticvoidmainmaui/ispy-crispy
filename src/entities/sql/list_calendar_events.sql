-- The get_calendar tool's read. Time-ordered, not relevance-ordered — a day plan is a
-- sequence, and idx_cal_user_starts answers it without touching the vector index.
-- $1 user_id   $2 from (nullable)   $3 to (nullable)   $4 limit

select id, title, content, starts_at, ends_at, location,
       place_lat, place_lon, status, tags
from calendar_events
where user_id = $1::uuid
  and status <> 'cancelled'
  and ($2::timestamptz is null or starts_at >= $2::timestamptz)
  and ($3::timestamptz is null or starts_at <  $3::timestamptz)
order by starts_at asc
limit $4;
