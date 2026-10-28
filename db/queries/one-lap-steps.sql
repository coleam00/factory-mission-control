WITH
-- The loop at the lap's own pin, as one-lap-map.sql picks it: each step's place in the loop
-- (Archon names a nested step by its path joined with `__`), so the browser lists the steps that
-- never started in the loop's order, after those that ran (#191).
version AS (
  SELECT a.archon_sha, a.factory_sha
  FROM mc.laps l
  CROSS JOIN mc.pins p
  JOIN mc.arch_versions a ON a.archon_sha = p.archon_sha
  WHERE l.factory = $1 AND l.run_id::text = $2 AND l.workflow_name = 'archon-loop'
  ORDER BY p.committed_at <= coalesce(l.started_at, 'infinity'::timestamptz) DESC,
    CASE WHEN p.committed_at <= coalesce(l.started_at, 'infinity'::timestamptz)
      THEN p.committed_at END DESC NULLS LAST,
    p.committed_at, a.parsed_at DESC
  LIMIT 1
),
loop AS (
  SELECT replace(s.path, '/', '__') AS step_id, s.position
  FROM mc.arch_steps s
  JOIN version v ON v.archon_sha = s.archon_sha AND v.factory_sha = s.factory_sha
  WHERE s.workflow = 'archon-loop'
)
SELECT
  -- Every attempt of every step the lap ran: each finished attempt (mc.lap_step_attempts) with the
  -- model and tokens its finishing event recorded (mc.lap_step_attempt_usage, 0015), and the step
  -- row of an attempt not finished yet, such as the running step. The step row holds its latest
  -- attempt's error, and stands in for an attempt whose usage row is missing.
  a.step_id, a.status, nullif(a.started_at, '-infinity') AS started_at, a.duration_ms,
  coalesce(u.model, s.model) AS model, coalesce(u.tokens_input, s.tokens_input) AS tokens_input,
  coalesce(u.tokens_output, s.tokens_output) AS tokens_output,
  coalesce(u.tokens_cache_read, s.tokens_cache_read) AS tokens_cache_read,
  coalesce(u.tokens_cache_write, s.tokens_cache_write) AS tokens_cache_write,
  a.cost_usd, a.outcome, s.error, o.position
FROM mc.laps l
JOIN mc.lap_step_attempts a ON a.run_id = l.run_id
LEFT JOIN loop o ON o.step_id = a.step_id
LEFT JOIN mc.lap_step_attempt_usage u ON u.event_id = a.event_id
LEFT JOIN mc.lap_steps s ON s.run_id = a.run_id AND s.step_id = a.step_id
  AND s.status <> 'running' AND coalesce(s.started_at, '-infinity') = a.started_at
WHERE l.factory = $1 AND l.run_id::text = $2 AND l.workflow_name = 'archon-loop'
UNION ALL
SELECT s.step_id, s.status, s.started_at, s.duration_ms, s.model, s.tokens_input,
  s.tokens_output, s.tokens_cache_read, s.tokens_cache_write, s.cost_usd,
  s.output ->> 'outcome', s.error, o.position
FROM mc.laps l
JOIN mc.lap_steps s ON s.run_id = l.run_id
LEFT JOIN loop o ON o.step_id = s.step_id
WHERE l.factory = $1 AND l.run_id::text = $2 AND l.workflow_name = 'archon-loop'
  AND NOT EXISTS (SELECT 1 FROM mc.lap_step_attempts a WHERE a.run_id = s.run_id
    AND a.step_id = s.step_id AND a.started_at = coalesce(s.started_at, '-infinity'))
