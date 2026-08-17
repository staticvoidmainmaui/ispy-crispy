-- Point a cluster member at its summary. Never deletes.
-- Distinct from superseded_by: that means contradicted, this means said-better-elsewhere.
-- $1 = member_id (uuid)   $2 = summary_id (uuid)

update memories
set metadata =
  metadata || jsonb_build_object(
    'consolidated_into', $2::text,
    'consolidated_at',   now()::text
  )
where id = $1
  and metadata->>'consolidated_into' is null
returning id, metadata;
