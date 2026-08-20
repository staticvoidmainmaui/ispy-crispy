-- $1 user_id  $2 retailer  $3 external_id  $4 content  $5 embedding
-- $6 brand  $7 model  $8 price_cents  $9 currency  $10 size
-- $11 attributes  $12 url  $13 in_stock  $14 tags  $15 metadata

insert into offers (
  user_id, retailer, external_id, content, embedding,
  brand, model, price_cents, currency, size,
  attributes, url, in_stock, tags, metadata
)
values (
  $1::uuid, $2, $3, $4, $5::vector(1024),
  $6, $7, $8::int, coalesce($9, 'USD'), $10,
  $11::jsonb, $12, coalesce($13::bool, true), $14::text[], $15::jsonb
)
on conflict (user_id, retailer, external_id) do update
set content     = excluded.content,
    embedding   = excluded.embedding,
    brand       = excluded.brand,
    model       = excluded.model,
    price_cents = excluded.price_cents,
    size        = excluded.size,
    attributes  = excluded.attributes,
    url         = excluded.url,
    in_stock    = excluded.in_stock,
    tags        = excluded.tags,
    metadata    = excluded.metadata,
    expires_at  = now() + interval '7 days'   -- a re-ingest is a fresh price
returning id, (xmax = 0) as inserted;
