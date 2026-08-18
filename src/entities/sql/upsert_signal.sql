-- One signal. Called per item inside one transaction — a workflow batch is atomic or it
-- is nothing. Multi-row VALUES would be fewer round trips but would move the SQL into a
-- JS string builder, and every query in this repo lives on disk.
--
-- xmax = 0 is the standard "was this an INSERT or an UPDATE" tell, so the webhook can
-- report inserted/updated separately instead of one meaningless total.
--
-- $1 user_id  $2 source  $3 external_id  $4 content  $5 embedding
-- $6 title  $7 url  $8 occurred_at  $9 tags  $10 metadata  $11 importance

insert into signals (
  user_id, source, external_id, content, embedding,
  title, url, occurred_at, tags, metadata, importance
)
values (
  $1::uuid, $2, $3, $4, $5::vector(1024),
  $6, $7, coalesce($8::timestamptz, now()), $9::text[], $10::jsonb,
  coalesce($11, 'medium')::importance_level
)
on conflict (user_id, source, external_id) do update
set content     = excluded.content,
    embedding   = excluded.embedding,
    title       = excluded.title,
    url         = excluded.url,
    occurred_at = excluded.occurred_at,
    tags        = excluded.tags,
    metadata    = excluded.metadata,
    importance  = excluded.importance
returning id, (xmax = 0) as inserted;
