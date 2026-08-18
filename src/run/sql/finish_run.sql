-- Close the unit. Guarded on 'running' so a late error can't overwrite a recorded success.
-- $1 run_id  $2 status  $3 latency_ms  $4 tokens_in  $5 tokens_out  $6 error  $7 intent

update agent_runs
set status      = $2::run_status,
    latency_ms  = $3,
    tokens_in   = $4,
    tokens_out  = $5,
    error       = $6,
    intent      = coalesce($7, intent),
    finished_at = now()
where id = $1::uuid
  and status = 'running'
returning id, status, latency_ms;
