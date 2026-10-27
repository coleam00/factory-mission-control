SELECT
  -- Every app-check line of the factory's laps: kind, verdict, a holdout's scenario id and the pull
  -- request it was checked on. Never a line's text (invariant 3).
  a.run_id, a.position, a.kind, a.verdict, a.scenario_id, l.started_at, s.output ->> 'pr' AS pr
FROM mc.app_check_lines a
JOIN mc.laps l ON l.run_id = a.run_id
LEFT JOIN mc.lap_steps s ON s.run_id = a.run_id AND s.step_id = 'check-app'
WHERE l.factory = $1 AND l.workflow_name = 'archon-loop'
