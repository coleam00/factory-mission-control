SELECT max(completed_at) AS swept_at
-- When the manager last swept: the completion time of the factory's last finished factory-manager
-- run, keyed by $1. One row, with swept_at null when the factory has no finished manager run.
FROM mc.laps
WHERE factory = $1 AND workflow_name = 'factory-manager' AND status = 'completed'
