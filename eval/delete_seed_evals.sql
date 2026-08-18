-- ─── Eval teardown ─── run by hand, after a session, against a DEV cluster.
--
-- The old version (`where user_id like 'eval-%'`) could never have worked: it was an
-- unterminated literal, and user_id became a uuid column, so there is no prefix to match.
-- Every run since has left ~26 orphan users behind.
--
-- There is no marker on a seeded row — the harness deliberately seeds through the real
-- write path, and /chat has no metadata field to stamp. So the only reliable handle is
-- the INVERSE: everything that is not a user you keep.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THIS DELETES EVERY USER NOT IN THE KEEP LIST. Add your real user ids below
-- before running it, and run the preview first.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Preview: who would go, and how much ──
with keep as (
  select unnest(array[
    '00000000-0000-0000-0000-000000000001'   -- DEV_USER (src/config.mjs)
    -- ,'<your-real-user-uuid>'
  ]::uuid[]) as user_id
)
select user_id, count(*) as memories
from memories
where user_id not in (select user_id from keep)
group by user_id
order by memories desc;

-- ── Delete ── uncomment when the preview looks right.
-- Ledger tables are absent on purpose: agent_runs cascades to tool_calls and
-- context_hits, and both it and proposed_actions expire on their own via 18.

-- A CTE binds to ONE statement, so the keep list is repeated per table rather than shared.
-- Keep the arrays identical.

-- delete from memories        where not (user_id = any(array['00000000-0000-0000-0000-000000000001']::uuid[]));
-- delete from calendar_events where not (user_id = any(array['00000000-0000-0000-0000-000000000001']::uuid[]));
-- delete from tasks           where not (user_id = any(array['00000000-0000-0000-0000-000000000001']::uuid[]));
-- delete from signals         where not (user_id = any(array['00000000-0000-0000-0000-000000000001']::uuid[]));
-- delete from offers          where not (user_id = any(array['00000000-0000-0000-0000-000000000001']::uuid[]));
-- delete from agent_runs      where not (user_id = any(array['00000000-0000-0000-0000-000000000001']::uuid[]));
