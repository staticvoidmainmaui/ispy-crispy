-- Phase 1 hardening — enforce dedup.
-- The `content_hash` column is GENERATED (sha256 of content), but a generated column only
-- COMPUTES a value; it doesn't stop two rows from sharing it. This index does: the same
-- user can't store the same content twice. That makes writeMemory safe to re-run.
--
-- Run this in the Supabase SQL editor AFTER 01_memories.sql.
-- If you already have duplicate rows from earlier runs, clear them first (see the DELETE
-- below) — the unique index can't be created while duplicates exist.

-- 1) Remove existing duplicates, keeping the oldest row per (user_id, content_hash).
delete from memories a
using memories b
where a.user_id = b.user_id
  and a.content_hash = b.content_hash
  and a.created_at > b.created_at;   -- delete the newer copies, keep the first

-- 2) Enforce it going forward. Now a re-insert of identical content conflicts on this index,
--    which is exactly what writeMemory's upsert (ON CONFLICT) will target.
create unique index if not exists uq_memories_user_content
  on memories (user_id, content_hash);
