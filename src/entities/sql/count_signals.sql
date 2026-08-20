-- The denominator. "Skipped 40 other items" is this minus what digest_signals returned.
-- $1 user_id   $2 since

select count(*)::int as considered
from signals
where user_id = $1::uuid
  and occurred_at >= $2::timestamptz
  and (expires_at is null or expires_at > now());
