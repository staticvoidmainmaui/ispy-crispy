-- Open the unit. Written before any LLM call so SSE has a run_id to emit immediately.
-- $1 user_id   $2 user_message   $3 intent   $4 model

insert into agent_runs (user_id, user_message, intent, model, status)
values ($1::uuid, $2, $3, $4, 'running')
returning id, started_at;
