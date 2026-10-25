SELECT l.run_id, l.digest, l.status, l.started_at, l.completed_at,
  s.step_id, s.duration_ms::float8 AS duration_ms, s.cost_usd::float8 AS cost_usd,
  s.output ->> 'route' AS route, s.output ->> 'outcome' AS outcome, s.output ->> 'reason' AS reason
FROM mc.laps l
LEFT JOIN mc.lap_steps s ON s.run_id = l.run_id
WHERE l.factory = $1 AND l.workflow_name = 'archon-loop' AND l.digest IS NOT NULL
UNION ALL
SELECT l.run_id, l.digest, l.status, l.started_at, l.completed_at,
  'holdout-catch', NULL, NULL, NULL, NULL, NULL
FROM mc.laps l
JOIN mc.app_check_lines a ON a.run_id = l.run_id
WHERE l.factory = $1 AND l.workflow_name = 'archon-loop' AND l.digest IS NOT NULL
  AND a.kind = 'holdout' AND a.verdict = 'FAIL' AND a.pre_existing = ''
