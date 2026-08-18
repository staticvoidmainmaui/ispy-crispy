-- Unlocked read, used only to decide whether an embedding is needed before BEGIN.
-- The authoritative read is lock_action.sql inside the transaction.
-- $1 id   $2 user_id

select id, run_id, user_id, action, target_kind, target_id, payload, rationale,
       status, expires_at
from proposed_actions
where id = $1::uuid
  and user_id = $2::uuid;
