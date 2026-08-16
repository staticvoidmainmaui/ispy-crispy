-- ─── dedup ─── ─── ported to CockroachDB.
-- Unique index on user_id and content_hash.
-- Since content_hash is a STORED generated column, which only COMPUTES
-- a value — it does not stop two rows from sharing one. This index does, and it is the
-- conflict target writeMemory.mjs's upsert names.
-- ─── ─── ─── ─── ─── 
create unique index if not exists uq_memories_user_content
  on memories (user_id, content_hash);
