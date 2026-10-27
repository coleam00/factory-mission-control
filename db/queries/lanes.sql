SELECT l.run_id, l.started_at, c.issue_number, i.title AS issue_title, i.url AS issue_url,
  -- The pick step's route, or else the one the lap's claim comment records (often first).
  coalesce(p.output ->> 'route', c.route) AS route, p.output ->> 'depth' AS depth,
  s.step_id, s.started_at AS step_started_at, k.cost_usd
FROM mc.laps l
LEFT JOIN LATERAL (
  SELECT c.issue_number, c.route FROM mc.claims c
  WHERE c.factory = l.factory AND c.run_id = l.run_id
  ORDER BY c.claimed_at DESC NULLS LAST, c.issue_number LIMIT 1
) c ON true
LEFT JOIN mc.issues i ON i.factory = l.factory AND i.number = c.issue_number
LEFT JOIN mc.lap_steps p ON p.run_id = l.run_id AND p.step_id = 'pick'
-- The step a lap is on: its newest running step, or else the last one it started.
LEFT JOIN LATERAL (
  SELECT ls.step_id, ls.started_at FROM mc.lap_steps ls
  WHERE ls.run_id = l.run_id
  ORDER BY ls.status = 'running' DESC, ls.started_at DESC NULLS LAST, ls.step_id LIMIT 1
) s ON true
-- Every finished run of every step, repeats included, as the scorecard counts a lap's cost (#116):
-- mc.lap_steps keeps only a step's latest run.
LEFT JOIN LATERAL (
  SELECT sum(a.cost_usd)::float8 AS cost_usd FROM mc.lap_step_attempts a WHERE a.run_id = l.run_id
) k ON true
WHERE l.factory = $1 AND l.workflow_name = 'archon-loop' AND l.status = 'running'
