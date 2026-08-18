-- Terminal transition. Guarded on 'pending' so an already-applied proposal cannot be
-- re-applied even if the lock is re-acquired.
-- $1 id   $2 status   $3 applied (bool — stamps applied_at)

update proposed_actions
set status     = $2::action_status,
    decided_at = now(),
    applied_at = case when $3::bool then now() else applied_at end
where id = $1::uuid
  and status = 'pending'
returning id, status, decided_at, applied_at;
