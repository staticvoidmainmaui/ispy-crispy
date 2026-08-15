-- Mark the loser of a contradiction. Never deletes.
-- $1 = loser_id (uuid)   $2 = winner_id (uuid)

update memories
set metadata =
  -- MERGE into existing metadata, don't replace it. 
  metadata || jsonb_build_object( 
    'superseded_by', $2::text, --cast with ::text
    'superseded_at', now()::text 
  )
where id = $1
  and metadata->>'superseded_by' is null
returning id, metadata;

