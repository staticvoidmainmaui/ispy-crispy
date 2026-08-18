-- "What is waiting on me?" — the count(*) that proves zero writes before approval.
-- $1 user_id   $2 status (nullable = all)   $3 run_id (nullable = all)   $4 limit

select id, run_id, action, target_kind, target_id, payload, rationale,
       status, created_at, decided_at, applied_at, expires_at
from proposed_actions
where user_id = $1::uuid
  and ($2::action_status is null or status = $2::action_status)
  and ($3::uuid is null or run_id = $3::uuid)
order by created_at desc
limit $4;
