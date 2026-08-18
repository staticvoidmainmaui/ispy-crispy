-- Bulk insert the whole chain in one statement.
-- One jsonb array rather than nine parallel arrays: pg's array encoding for jsonb[] is
-- fragile, and the shape here is already objects.
-- $1 run_id   $2 jsonb array of { seq, iteration, tool_name, input, output, ok, error, latency_ms }

insert into tool_calls (run_id, seq, iteration, tool_name, input, output, ok, error, latency_ms)
select $1::uuid,
       (e->>'seq')::int,
       (e->>'iteration')::int,
       e->>'tool_name',
       e->'input',
       e->'output',
       (e->>'ok')::bool,
       e->>'error',
       (e->>'latency_ms')::int
from jsonb_array_elements($2::jsonb) as e
returning id, seq;
