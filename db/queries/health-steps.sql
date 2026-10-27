SELECT 'running' AS kind, ls.run_id, l.workflow_name, ls.step_id, ls.started_at AS at,
  NULL::float8 AS duration_ms
FROM mc.lap_steps ls
JOIN mc.laps l ON l.run_id = ls.run_id
WHERE l.factory = $1 AND l.status = 'running' AND ls.status = 'running'
UNION ALL
-- The latest 50 completions of each running step in the factory's laps of its workflow. The
-- browser takes their 90th percentile and sets it against how long the step has run.
SELECT 'completion', c.run_id, r.workflow_name, r.step_id, c.completed_at, c.duration_ms::float8
FROM (
  SELECT DISTINCT l.workflow_name, ls.step_id
  FROM mc.lap_steps ls
  JOIN mc.laps l ON l.run_id = ls.run_id
  WHERE l.factory = $1 AND l.status = 'running' AND ls.status = 'running'
) r
CROSS JOIN LATERAL (
  SELECT ls.run_id, ls.completed_at, ls.duration_ms
  FROM mc.lap_steps ls
  JOIN mc.laps l ON l.run_id = ls.run_id
  WHERE l.factory = $1 AND l.workflow_name = r.workflow_name AND ls.step_id = r.step_id
    AND ls.status = 'completed' AND ls.duration_ms IS NOT NULL AND ls.completed_at IS NOT NULL
  ORDER BY ls.completed_at DESC, ls.run_id LIMIT 50
) c
