-- Insert one calendar event. Replaces the putEvent() + writeMemory() dual write.
-- $1 id (nullable -> generated)   $2 user_id      $3 content      $4 embedding
-- $5 title      $6 starts_at      $7 ends_at      $8 location
-- $9 place_lat  $10 place_lon     $11 status      $12 source
-- $13 tags      $14 metadata      $15 importance  $16 created_at (nullable -> now)

insert into calendar_events (
  id, user_id, content, embedding,
  title, starts_at, ends_at, location,
  place_lat, place_lon, status, source,
  tags, metadata, importance, created_at
)
values (
  coalesce($1::uuid, gen_random_uuid()), $2::uuid, $3, $4::vector(1024),
  $5, $6::timestamptz, $7::timestamptz, $8,
  $9::float8, $10::float8, coalesce($11, 'scheduled'), coalesce($12, 'chat'),
  $13::text[], $14::jsonb, coalesce($15, 'medium')::importance_level,
  coalesce($16::timestamptz, now())
)
returning id, title, starts_at, ends_at, location, status;
