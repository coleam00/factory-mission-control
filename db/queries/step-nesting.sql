WITH queues AS (
  -- A factory on the queues has run a workflow only the queue pack has (home-map.sql's queues
  -- row). Its runs follow no pin, so its current version is the architecture parsed last (#435).
  SELECT EXISTS (SELECT 1 FROM mc.laps l
    WHERE l.factory = $1 AND l.workflow_name IN ('archon-intake', 'archon-build-queue')) AS on_queues
),
version AS (
  -- The version the address names by its pin, $4, or for '' the current version: on a factory on
  -- the queues the architecture parsed last, pinned or not, on any other the architecture of the
  -- newest pin that has any.
  SELECT a.archon_sha, a.factory_sha, a.parsed_at, p.sha AS pin
  FROM mc.arch_versions a
  JOIN mc.factories f ON f.name = $1
  CROSS JOIN queues q
  LEFT JOIN mc.pins p ON p.archon_sha = a.archon_sha
  WHERE CASE WHEN $4 = '' THEN q.on_queues OR p.sha IS NOT NULL ELSE p.sha = $4 END
  ORDER BY CASE WHEN $4 = '' AND q.on_queues THEN a.parsed_at END DESC NULLS LAST,
    p.committed_at DESC NULLS LAST, a.parsed_at DESC
  LIMIT 1
)
-- The nodes beneath the step in its workflow. Each opens its own place in that workflow: an
-- include's copies repeat the definition, so the declared rows still answer for them.
SELECT s.path, s.position, s.step_id, s.kind
FROM mc.arch_steps s
JOIN version v ON v.archon_sha = s.archon_sha AND v.factory_sha = s.factory_sha
WHERE s.workflow = $2 AND starts_with(s.path, $3 || '/')
