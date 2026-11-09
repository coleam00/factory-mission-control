SELECT s.run_id, s.output ->> 'written' AS written, s.output ->> 'dropped' AS dropped
-- The Board's "Found by the factory": the filed, tracked and dropped lists of each finished
-- outcome step of the factory's discoveries runs, as JSON text for the browser to count.
FROM mc.laps l
JOIN mc.lap_steps s ON s.run_id = l.run_id AND s.step_id = 'outcome' AND s.status = 'completed'
WHERE l.factory = $1 AND l.workflow_name = 'archon-discoveries'
ORDER BY s.run_id
