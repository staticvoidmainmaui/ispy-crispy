-- ─── Row-level TTL for the new kinds ─── same mechanism as 09 and to be combined with 09
--
-- Physical GC only. What is RETURNED is still decided by the `expires_at > now()`
-- predicates in 16. Apply 10-17 and confirm recall works before this file.
--
-- tool_calls and context_hits are absent on purpose — they GC by FK cascade off agent_runs.
--
-- Docs: https://www.cockroachlabs.com/docs/stable/row-level-ttl

alter table signals set (
  ttl_expiration_expression = 'expires_at',
  ttl_job_cron = '@daily'
);

alter table offers set (
  ttl_expiration_expression = 'expires_at',
  ttl_job_cron = '@daily'
);

alter table agent_runs set (
  ttl_expiration_expression = 'expires_at',
  ttl_job_cron = '@daily'
);

alter table proposed_actions set (
  ttl_expiration_expression = 'expires_at',
  ttl_job_cron = '@daily'
);
