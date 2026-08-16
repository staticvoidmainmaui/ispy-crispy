-- Users worth reflecting over: semantic memories written recently.
-- $1 = lookback interval in days (int)

select distinct m.user_id
from memories m
where m.memory_type = 'semantic'
  and m.created_at > now() - ($1 || ' days')::interval
order by m.user_id;
