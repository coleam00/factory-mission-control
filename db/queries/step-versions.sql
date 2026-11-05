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
  WHERE CASE WHEN '' = '' THEN q.on_queues OR p.sha IS NOT NULL ELSE p.sha = '' END
  ORDER BY CASE WHEN '' = '' AND q.on_queues THEN a.parsed_at END DESC NULLS LAST,
    p.committed_at DESC NULLS LAST, a.parsed_at DESC
  LIMIT 1
)
-- Every pin with architecture: the versions the step screen and the home map can open. Pins are
-- shared by every factory (PRD 11.2). The current one is the newest pin naming the current
-- version's Archon commit.
SELECT p.sha, p.reason, p.committed_at, p.sha IS NOT DISTINCT FROM v.pin AS is_current
FROM mc.pins p
JOIN mc.factories f ON f.name = $1
CROSS JOIN version v
WHERE EXISTS (SELECT 1 FROM mc.arch_versions a WHERE a.archon_sha = p.archon_sha)
UNION ALL
-- On a factory on the queues, the current version when no pin names its Archon commit: by that
-- commit, dated when it was parsed. It opens only as the current version, never by address.
SELECT v.archon_sha, NULL, v.parsed_at, true
FROM version v
WHERE v.pin IS NULL
