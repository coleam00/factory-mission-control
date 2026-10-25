SELECT l.run_id, l.digest, l.workflow_name, l.status, l.started_at, l.completed_at,
  a.step_id, a.duration_ms::float8 AS duration_ms, a.cost_usd::float8 AS cost_usd, a.route,
  a.outcome, a.reason, a.holdout_catches, NULL::text AS pin_sha, NULL::timestamptz AS committed_at
FROM mc.laps l
LEFT JOIN mc.lap_step_attempts a ON a.run_id = l.run_id AND l.workflow_name = 'archon-loop'
WHERE l.factory = $1 AND l.digest IS NOT NULL
UNION ALL
SELECT NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, p.sha,
  p.committed_at
FROM mc.pins p
