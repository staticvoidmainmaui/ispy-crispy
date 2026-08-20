-- The agent's only write surface. Never touches calendar_events.
-- $1 run_id  $2 user_id  $3 action  $4 target_kind  $5 target_id  $6 payload  $7 rationale

insert into proposed_actions (run_id, user_id, action, target_kind, target_id, payload, rationale)
values ($1::uuid, $2::uuid, $3, $4::entity_kind, $5::uuid, $6::jsonb, $7)
returning id, action, payload, rationale, status, created_at, expires_at;
