SELECT l.run_id, l.workflow_name, l.status, l.started_at, l.completed_at,
  f.step_id AS failed_step, f.error, f.completed_at AS failed_at
FROM mc.laps l
-- The run's latest failed step: its error names the cause.
LEFT JOIN LATERAL (
  SELECT ls.step_id, ls.error, ls.completed_at FROM mc.lap_steps ls
  WHERE ls.run_id = l.run_id AND ls.status = 'failed'
  ORDER BY ls.completed_at DESC NULLS LAST, ls.step_id LIMIT 1
) f ON true
-- A run has failed when its status says so or one of its steps failed: a step's failure lands
-- before the run's status catches up.
WHERE l.factory = $1 AND (l.status IN ('pending', 'paused', 'failed') OR f.step_id IS NOT NULL)
