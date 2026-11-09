WITH queues AS (
  -- A factory on the queues has run a workflow only the queue pack has (home-map.sql's queues
  -- row). Its runs follow no pin, so its current version is the architecture parsed last (#435).
  SELECT EXISTS (SELECT 1 FROM mc.laps l
    WHERE l.factory = $1 AND l.workflow_name IN ('archon-intake', 'archon-build-queue')) AS on_queues
),
version AS (
  -- The version the address names by its pin or its archon_sha (the unpinned queue pack), $4, or for '' the current version: on a factory on
  -- the queues the architecture parsed last, pinned or not, on any other the architecture of the
  -- newest pin that has any.
  SELECT a.archon_sha, a.factory_sha, a.parsed_at, p.sha AS pin
  FROM mc.arch_versions a
  JOIN mc.factories f ON f.name = $1
  CROSS JOIN queues q
  LEFT JOIN mc.pins p ON p.archon_sha = a.archon_sha
  WHERE CASE WHEN $4 = '' THEN q.on_queues OR p.sha IS NOT NULL ELSE (p.sha = $4 OR a.archon_sha = $4) END
  ORDER BY CASE WHEN $4 = '' AND q.on_queues THEN a.parsed_at END DESC NULLS LAST,
    p.committed_at DESC NULLS LAST, a.parsed_at DESC
  LIMIT 1
),
step AS (
  SELECT s.script_file
  FROM mc.arch_steps s
  JOIN version v ON v.archon_sha = s.archon_sha AND v.factory_sha = s.factory_sha
  WHERE s.workflow = $2 AND s.path = $3
)
-- The script file the step runs, in parts as in step-prompt.sql.
SELECT c.path, n.part, substr(c.text, n.part * 4000 + 1, 4000) AS chunk
FROM mc.arch_scripts c
JOIN version v ON v.archon_sha = c.archon_sha AND v.factory_sha = c.factory_sha
JOIN step s ON s.script_file = c.path
JOIN (VALUES (0), (1), (2), (3), (4), (5), (6), (7), (8), (9), (10), (11), (12), (13), (14), (15), (16), (17), (18), (19), (20), (21), (22), (23), (24)) AS n(part)
  ON n.part * 4000 < length(c.text)
