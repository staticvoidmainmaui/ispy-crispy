-- Memories that have never been tagged. Input to the tagging pass.
-- $1 = user_id (uuid)   $2 = limit (int)
--
-- Only live rows: tagging a superseded or consolidated-away memory spends an LLM call
-- on something no query will ever return. Only unexpired, for the same reason.
--
-- tags = '{}' (the column default) is the "never tagged" marker. There is no separate
-- flag, which means a row the tagger legitimately decides has NO applicable tag will be
-- offered again on the next run. Accepted for now: the controlled vocabulary is broad
-- enough that near-everything gets at least one tag. If empty-tag rows start churning,
-- the fix is a metadata 'tagged_at' stamp, not a widened vocabulary.

select id, content
from memories
where user_id = $1
  and tags = '{}'
  and metadata->>'superseded_by' is null
  and metadata->>'consolidated_into' is null
  and (expires_at is null or expires_at > now())
order by created_at desc   -- newest first: recent memories are likelier to be recalled
limit $2;
