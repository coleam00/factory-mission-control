SELECT f.name AS factory, count(l.run_id)::int AS running, f.name = $1 AS is_default
FROM mc.factories f
LEFT JOIN mc.laps l
  ON l.factory = f.name AND l.workflow_name = 'archon-loop' AND l.status = 'running'
GROUP BY f.name
