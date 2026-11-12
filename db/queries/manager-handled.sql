SELECT l.run_id::text AS run_id, l.completed_at,
  (CASE WHEN jsonb_typeof(s.output -> 'answered') = 'array'
    THEN jsonb_array_length(s.output -> 'answered') ELSE 0 END)::int AS answered
-- What the factory's manager answered on its own, for Attention's handled line: each completed
-- factory-manager run's `manage` step lists what it answered. Newest first, and the browser keeps
-- today's, because a live query may not read the clock. The CASE keeps a step whose output has no
-- list from raising in jsonb_array_length.
FROM mc.laps l
JOIN mc.lap_steps s ON s.run_id = l.run_id AND s.step_id = 'manage' AND s.status = 'completed'
WHERE l.factory = $1 AND l.workflow_name = 'factory-manager' AND l.status = 'completed'
  AND (CASE WHEN jsonb_typeof(s.output -> 'answered') = 'array'
    THEN jsonb_array_length(s.output -> 'answered') ELSE 0 END) > 0
ORDER BY l.completed_at DESC, l.run_id DESC
LIMIT 100
