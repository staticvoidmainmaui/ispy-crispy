-- ─── offers ───  NOT ARBITRARY and currently scoped to demo 4 - 
-- CAN/SHOULD be turned into a general-purpose "offers" table if the need arises. 
--
-- Read-only to the agent: a workflow fills it, search_offers filters it, the reply hands
-- back a URL. No write path from the tool loop.
-- The constraints ("10.5, neutral, under $140, not Nike") come from `memories`, so the
-- typed columns exist to be filtered BY them.

drop table if exists offers cascade;

create table offers (
  -- ── contract (10) ──
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null,
  content       text not null,
  embedding     vector(1024),
  importance    importance_level not null default 'medium',
  tags          text[]  default '{}',
  metadata      jsonb   default '{}',
  access_count      int         default 0,
  last_accessed_at  timestamptz,
  expires_at        timestamptz default now() + interval '7 days',  -- a stale price shown as current is worse than no answer
  created_at        timestamptz default now(),

  -- ── typed ──
  brand        text,
  model        text,
  price_cents  int,                  -- integer cents, never float dollars
  currency     text default 'USD',
  size         text,                 -- text: "10.5", "10.5 wide", "M"
  attributes   jsonb default '{}',   -- {"support":"neutral","toebox":"wide"}
  url          text,
  in_stock     bool default true,
  retailer     text,
  external_id  text
);

create unique index uq_offer_external on offers (user_id, retailer, external_id);
create index idx_offer_user_price on offers (user_id, price_cents);

create vector index idx_offer_embedding on offers (embedding vector_cosine_ops);
create index idx_offer_tags on offers using gin (tags);
