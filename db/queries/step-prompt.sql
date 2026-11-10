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
  SELECT s.command_file
  FROM mc.arch_steps s
  JOIN version v ON v.archon_sha = s.archon_sha AND v.factory_sha = s.factory_sha
  WHERE s.workflow = $2 AND s.path = $3
)
-- The command file the step runs, in parts the browser joins in order: each part stays
-- under the 16 KiB the live probe tests (REALTIME.md): 4000 characters are at most 16,000 bytes at four bytes each, and 25
-- parts hold a file of 100,000.
SELECT t.path, n.part, substr(t.text, n.part * 4000 + 1, 4000) AS chunk
FROM mc.arch_texts t
JOIN version v ON v.archon_sha = t.archon_sha AND v.factory_sha = t.factory_sha
JOIN step s ON s.command_file = t.path
JOIN (VALUES (0), (1), (2), (3), (4), (5), (6), (7), (8), (9), (10), (11), (12), (13), (14), (15), (16), (17), (18), (19), (20), (21), (22), (23), (24)) AS n(part)
  ON n.part * 4000 < length(t.text)
