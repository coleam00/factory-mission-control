SELECT r.run_id, r.workflow_name, r.step_id, r.line, r.stopped_at
-- The transient failures a later completed run of their workflow retried, for the retried line on Runs > Failures (issue #628).
-- $1 is the factory, $2 is the start of the viewer's local day as an instant (`retriedArgs` in app/lib/failure-view.ts).
-- "Today" is the viewer's local day, which the page passes: a live query may not read the clock.
FROM mc.run_stops r
WHERE r.factory = $1 AND r.status = 'failed' AND r.class = 'transient'
  AND r.stopped_at >= $2::timestamptz
  AND EXISTS (
    SELECT 1 FROM mc.run_stops o
    WHERE o.factory = r.factory AND o.status = 'completed' AND o.workflow_name = r.workflow_name
      AND o.stopped_at > r.stopped_at
  )
ORDER BY r.stopped_at DESC, r.run_id DESC
