-- $1 user_id  $2 source  $3 external_id  $4 content  $5 embedding
-- $6 title  $7 state  $8 due_at  $9 effort_minutes  $10 project
-- $11 tags  $12 metadata  $13 importance
--
-- The conflict target is the PARTIAL index from 12 — it only fires when external_id is
-- non-null, so a chat-created task never collides with another chat-created task.

insert into tasks (
  user_id, source, external_id, content, embedding,
  title, state, due_at, effort_minutes, project,
  tags, metadata, importance
)
values (
  $1::uuid, coalesce($2, 'chat'), $3, $4, $5::vector(1024),
  $6, coalesce($7, 'open'), $8::timestamptz, $9::int, $10,
  $11::text[], $12::jsonb, coalesce($13, 'medium')::importance_level
)
on conflict (user_id, source, external_id) where external_id is not null do update
set content        = excluded.content,
    embedding      = excluded.embedding,
    title          = excluded.title,
    state          = excluded.state,
    due_at         = excluded.due_at,
    effort_minutes = excluded.effort_minutes,
    project        = excluded.project,
    tags           = excluded.tags,
    metadata       = excluded.metadata,
    importance     = excluded.importance
returning id, (xmax = 0) as inserted;
