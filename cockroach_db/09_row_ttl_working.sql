-- ─── Row-level TTL ─── let CockroachDB do the garbage collection.
--
-- Apply 08 first and confirm recall still works; this file only changes
-- whether lapsed rows are physically REMOVED, never whether they are RETURNED.
-- 08's `expires_at > now()` filter is the correctness guarantee and stands alone.

-- Docs: https://www.cockroachlabs.com/docs/stable/row-level-ttl
--
alter table memories set (
  ttl_expiration_expression = 'expires_at',
  ttl_job_cron = '@daily'   -- matches the nightly ReflectAgent cadence,  no extra scheduler
);
