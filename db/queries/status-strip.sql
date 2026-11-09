WITH queues AS (
  -- A factory on the queues has run a workflow only the queue pack has (home-map.sql's queues
  -- row). Its runs follow no pin, so its current version is the architecture parsed last (#435).
  SELECT EXISTS (SELECT 1 FROM mc.laps l
    WHERE l.factory = $1 AND l.workflow_name IN ('archon-intake', 'archon-build-queue')) AS on_queues
),
version AS (
  -- The version the step screen shows without one in its address (step-detail.sql).
  SELECT a.archon_sha, a.parsed_at, p.sha AS pin
  FROM mc.arch_versions a
  JOIN mc.factories f ON f.name = $1
  CROSS JOIN queues q
  LEFT JOIN mc.pins p ON p.archon_sha = a.archon_sha
  WHERE q.on_queues OR p.sha IS NOT NULL
  ORDER BY CASE WHEN q.on_queues THEN a.parsed_at END DESC NULLS LAST,
    p.committed_at DESC NULLS LAST, a.parsed_at DESC
  LIMIT 1
)
SELECT
  -- The nav footer's facts for one factory: runs running, runs waiting for a slot, and the engine
  -- version: the Archon commit of the version the step screen shows without one in its address
  -- (the rule above is step-detail.sql's; version-rule.test.ts holds it there). Null before any
  -- architecture is parsed.
  (SELECT count(*)::int FROM mc.laps WHERE factory = $1 AND status = 'running') AS running,
  (SELECT count(*)::int FROM mc.capacity_waits WHERE factory = $1) AS waiting,
  (SELECT archon_sha FROM version) AS engine
