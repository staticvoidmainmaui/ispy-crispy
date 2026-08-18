-- Claim the proposal for the length of the transaction. FOR UPDATE is what makes a
-- double-click one calendar write instead of two.
-- $1 id   $2 user_id

select id, run_id, user_id, action, target_kind, target_id, payload, rationale,
       status, expires_at
from proposed_actions
where id = $1::uuid
  and user_id = $2::uuid
for update;
