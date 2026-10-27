SELECT l.run_id, l.status, l.started_at,
  -- The pick step's route, or else the one the lap's claim comment records, as lanes.sql reads it.
  coalesce(p.output ->> 'route', c.route) AS route, p.output ->> 'depth' AS depth
FROM mc.laps l
LEFT JOIN LATERAL (
  SELECT c.route FROM mc.claims c
  WHERE c.factory = l.factory AND c.run_id = l.run_id
  ORDER BY c.claimed_at DESC NULLS LAST, c.issue_number LIMIT 1
) c ON true
LEFT JOIN mc.lap_steps p ON p.run_id = l.run_id AND p.step_id = 'pick'
WHERE l.factory = $1 AND l.workflow_name = 'archon-loop'
