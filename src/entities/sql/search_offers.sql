-- Preference-constrained product search. Every filter here comes from a memory the user
-- never restated in the request — that is the demo.
--
-- `@>` is jsonb containment: {"support":"neutral"} matches any row whose attributes
-- include that pair, ignoring the rest.
--
-- $1 user_id  $2 embedding  $3 max_price_cents  $4 size
-- $5 attributes (jsonb)  $6 exclude_brands (text[])  $7 limit

select id, brand, model, price_cents, currency, size, attributes, url, in_stock, content,
       (embedding <=> $2::vector(1024)) as distance
from offers
where user_id = $1::uuid
  and in_stock
  and (expires_at is null or expires_at > now())
  and ($3::int   is null or price_cents <= $3::int)
  and ($4::text  is null or size = $4::text)
  and ($5::jsonb is null or attributes @> $5::jsonb)
  and ($6::text[] is null or brand is null or not (brand = any($6::text[])))
order by embedding <=> $2::vector(1024)
limit $7;
