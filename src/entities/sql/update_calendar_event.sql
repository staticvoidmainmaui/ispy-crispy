-- Apply an approved mutation. COALESCE means "null = leave alone", so one statement
-- serves move_event, cancel_event, and a location change.
-- Embedding is recomputed by the caller only when content changed; null keeps the old one.
-- $1 id  $2 user_id  $3 content  $4 embedding  $5 title
-- $6 starts_at  $7 ends_at  $8 location  $9 place_lat  $10 place_lon  $11 status

update calendar_events
set content    = coalesce($3, content),
    embedding  = coalesce($4::vector(1024), embedding),
    title      = coalesce($5, title),
    starts_at  = coalesce($6::timestamptz, starts_at),
    ends_at    = coalesce($7::timestamptz, ends_at),
    location   = coalesce($8, location),
    place_lat  = coalesce($9::float8, place_lat),
    place_lon  = coalesce($10::float8, place_lon),
    status     = coalesce($11, status)
where id = $1::uuid
  and user_id = $2::uuid
returning id, title, starts_at, ends_at, location, status;
