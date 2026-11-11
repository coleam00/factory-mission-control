WITH last AS (
  SELECT max((s.stopped_at AT TIME ZONE 'UTC')::date) AS day FROM mc.run_stops s WHERE s.factory = $1
)
SELECT r.run_id, r.workflow_name, r.step_id, r.line, r.stopped_at
-- The transient failures a later completed run of their workflow retried, for Attention's muted line (issue #628).
-- "Today" is the factory's latest UTC stop day, the anchor failure-groups uses: a live query may not read the clock.
FROM mc.run_stops r CROSS JOIN last
WHERE r.factory = $1 AND r.status = 'failed' AND r.class = 'transient'
  AND (r.stopped_at AT TIME ZONE 'UTC')::date = last.day
  AND EXISTS (
    SELECT 1 FROM mc.run_stops o
    WHERE o.factory = r.factory AND o.status = 'completed' AND o.workflow_name = r.workflow_name
      AND o.stopped_at > r.stopped_at
  )
ORDER BY r.stopped_at DESC, r.run_id DESC
