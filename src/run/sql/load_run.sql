-- Replay source. One round trip for the whole unit, so GET /runs/:id/events can rebuild
-- the same frames the live stream emitted.
-- $1 run_id   $2 user_id

select
  (select to_jsonb(r) from agent_runs r where r.id = $1::uuid) as run,

  (select coalesce(jsonb_agg(to_jsonb(h) order by h.rank), '[]'::jsonb)
     from context_hits h where h.run_id = $1::uuid) as hits,

  (select coalesce(jsonb_agg(to_jsonb(t) order by t.seq), '[]'::jsonb)
     from tool_calls t where t.run_id = $1::uuid) as tools,

  (select coalesce(jsonb_agg(to_jsonb(p) order by p.created_at), '[]'::jsonb)
     from proposed_actions p where p.run_id = $1::uuid) as proposals
where exists (
  select 1 from agent_runs r where r.id = $1::uuid and r.user_id = $2::uuid
);
