SELECT
  -- The nav footer's facts for one factory: runs running, runs waiting for a slot, and the engine
  -- version (the Archon commit of the newest pin its laps ran under, null before any is known).
  (SELECT count(*)::int FROM mc.laps WHERE factory = $1 AND status = 'running') AS running,
  (SELECT count(*)::int FROM mc.capacity_waits WHERE factory = $1) AS waiting,
  (SELECT p.archon_sha FROM mc.versions v JOIN mc.pins p ON p.sha = v.pin_sha
    WHERE v.factory = $1 ORDER BY v.first_run_at DESC LIMIT 1) AS engine
