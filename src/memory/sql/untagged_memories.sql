-- Live, untagged memories. Input to the tagging pass.
-- $1 = user_id (uuid)   $2 = limit (int)

select id, content
from memories
where user_id = $1
  and tags = '{}'
  and metadata->>'superseded_by' is null
  and metadata->>'consolidated_into' is null
  and (expires_at is null or expires_at > now())
order by created_at desc   -- newest first: recent memories are likelier to be recalled
limit $2;
