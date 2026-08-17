-- Promote frequently-recalled memories one importance step. Idempotent (promoted_at guard).
-- $1 = user_id (uuid)   $2 = min_access (int)

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
