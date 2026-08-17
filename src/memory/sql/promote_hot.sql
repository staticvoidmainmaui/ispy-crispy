-- Promote frequently-recalled memories one importance step. The DURABLE half of
-- promotion after score recomputation. This is the "hot" promotion signal.
-- $1 = user_id (uuid)   $2 = min_access (int)
--
-- Why a durable bump on top of the score term: the score term decays out of view if a
-- memory goes quiet, which is right for ranking but wrong for record-keeping. A memory
-- you needed twenty times has PROVEN it matters, and that fact should outlive the streak.
--
-- One step only, capped at 'high'. 'critical' stays reserved for a human saying so —
-- nothing should reach the top of the scale by being asked about a lot.
-- The metadata guard makes this idempotent: a row promotes once, not once per nightly run.

update memories
set importance = case importance
      when 'trivial' then 'low'
      when 'low'     then 'medium'
      when 'medium'  then 'high'
      else importance          -- 'high' and 'critical' are already at/above the cap
    end,
    metadata = metadata || jsonb_build_object(
      'promoted_at',   now()::text,
      'promoted_from', importance::text  -- keep the old value: promotion is auditable
    )
where user_id = $1
  and access_count >= $2
  and importance in ('trivial', 'low', 'medium')   -- skip rows the case would no-op
  and metadata->>'promoted_at' is null             -- promote once, ever
  and metadata->>'superseded_by' is null
  and metadata->>'consolidated_into' is null
returning id, importance, access_count;
