SELECT l.run_id, l.digest, l.workflow_name, l.status, l.started_at, l.completed_at,
  NULL::text AS step_id, NULL::float8 AS duration_ms, NULL::float8 AS cost_usd, NULL::text AS route,
  NULL::text AS outcome, NULL::text AS reason, NULL::text AS pin_sha,
  NULL::timestamptz AS first_run_at,
  fl.output -> 'item' ->> 'number' AS issue, fl.output -> 'pull_request' ->> 'number' AS pull_request,
  NULL::text AS merged, NULL::text AS items
FROM mc.laps l
LEFT JOIN mc.lap_steps fl ON fl.run_id = l.run_id AND fl.step_id = 'facts'
WHERE l.factory = $1 AND (l.workflow_name = 'archon-loop' OR l.workflow_name = 'archon-build-queue' AND EXISTS (
    SELECT 1 FROM mc.lap_steps f WHERE f.run_id = l.run_id AND f.step_id = 'facts'
      AND f.output -> 'item' ->> 'number' IS NOT NULL)) AND l.digest IS NOT NULL
UNION ALL
SELECT a.run_id, NULL, NULL, NULL, NULL, NULL, a.step_id, a.duration_ms::float8, a.cost_usd::float8,
  a.route, a.outcome, a.reason, NULL, NULL, NULL, NULL, NULL, NULL
FROM mc.lap_step_attempts a
JOIN mc.laps l ON l.run_id = a.run_id
WHERE l.factory = $1 AND (l.workflow_name = 'archon-loop' OR l.workflow_name = 'archon-build-queue' AND EXISTS (
    SELECT 1 FROM mc.lap_steps f WHERE f.run_id = l.run_id AND f.step_id = 'facts'
      AND f.output -> 'item' ->> 'number' IS NOT NULL)) AND l.digest IS NOT NULL
  AND (a.cost_usd IS NOT NULL OR a.step_id IN ('pick', 'review', 'land', 'check-app'))
UNION ALL
SELECT NULL, v.digest, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, v.pin_sha,
  v.first_run_at, NULL, NULL, NULL, NULL
FROM mc.versions v
WHERE v.factory = $1
UNION ALL
-- Each run whose record step read pull requests back as merged (the queue's sweep is the only record
-- step with that output, as in home-map), with that list
-- and the run's facts items (each pull request's issue) as JSON text: Realtime refuses a
-- set-returning function to expand them, so the browser credits each pull request to the build lap.
SELECT l.run_id, NULL, l.workflow_name, NULL, NULL,
  coalesce(rec.completed_at, rec.started_at + rec.duration_ms * interval '1 millisecond'),
  NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
  (rec.output -> 'merged')::text, (fm.output -> 'items')::text
FROM mc.laps l
JOIN mc.lap_steps rec ON rec.run_id = l.run_id AND rec.step_id = 'record'
  AND rec.status = 'completed' AND rec.output -> 'merged' IS NOT NULL
  AND rec.output -> 'merged' <> '[]'::jsonb
LEFT JOIN mc.lap_steps fm ON fm.run_id = l.run_id AND fm.step_id = 'facts'
WHERE l.factory = $1
