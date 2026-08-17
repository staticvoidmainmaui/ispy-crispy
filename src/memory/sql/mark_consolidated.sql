-- Point a cluster member at the summary that now speaks for it. Never deletes.
-- $1 = member_id (uuid)   $2 = summary_id (uuid)
--
-- Same jsonb-merge shape as mark_superseded.sql, and deliberately a DIFFERENT key:
--   superseded_by     -> "this was contradicted, a newer belief replaced it"
--   consolidated_into -> "this is still true, a summary just says it better"
-- Both hide the row from recall (08 filters on each), but they are not the same event
-- and collapsing them would lose the distinction the next reader needs.
--
-- The null guard makes it idempotent: a member already folded into one summary is not
-- re-pointed at another, so a re-run can't shuffle rows between clusters.

update memories
set metadata =
  metadata || jsonb_build_object(
    'consolidated_into', $2::text,
    'consolidated_at',   now()::text
  )
where id = $1
  and metadata->>'consolidated_into' is null
returning id, metadata;
