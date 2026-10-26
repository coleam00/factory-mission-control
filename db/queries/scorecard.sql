SELECT l.run_id, l.digest, l.workflow_name, l.status, l.started_at, l.completed_at,
  NULL::text AS step_id, NULL::float8 AS duration_ms, NULL::float8 AS cost_usd, NULL::text AS route,
  NULL::text AS outcome, NULL::text AS reason, NULL::int AS holdout_catches, NULL::text AS pin_sha,
  NULL::timestamptz AS committed_at
FROM mc.laps l
WHERE l.factory = $1 AND l.digest IS NOT NULL
UNION ALL
SELECT a.run_id, NULL, NULL, NULL, NULL, NULL, a.step_id, a.duration_ms::float8, a.cost_usd::float8,
  a.route, a.outcome, a.reason, a.holdout_catches, NULL, NULL
FROM mc.lap_step_attempts a
JOIN mc.laps l ON l.run_id = a.run_id
WHERE l.factory = $1 AND l.workflow_name = 'archon-loop' AND l.digest IS NOT NULL
  AND (a.cost_usd IS NOT NULL OR a.step_id IN ('pick', 'review', 'land', 'check-app'))
UNION ALL
SELECT NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, p.sha,
  p.committed_at
FROM mc.pins p
WHERE p.factory = $1
