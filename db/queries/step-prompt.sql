WITH version AS (
  -- The version the address names by its pin, $4, or for '' the current version: the
  -- architecture of the newest pin that has any.
  SELECT a.archon_sha, a.factory_sha
  FROM mc.arch_versions a
  JOIN mc.pins p ON p.archon_sha = a.archon_sha
  JOIN mc.factories f ON f.name = $1
  WHERE $4 = '' OR p.sha = $4
  ORDER BY p.committed_at DESC, a.parsed_at DESC
  LIMIT 1
),
step AS (
  SELECT s.command_file
  FROM mc.arch_steps s
  JOIN version v ON v.archon_sha = s.archon_sha AND v.factory_sha = s.factory_sha
  WHERE s.workflow = $2 AND s.path = $3
)
-- The command file the step runs, in parts the browser joins in order: Realtime never answers a
-- query with a value of 16 KiB or more (REALTIME.md). 4000 characters stay under that at four
-- bytes each, and 25 parts hold a file of 100,000.
SELECT t.path, n.part, substr(t.text, n.part * 4000 + 1, 4000) AS chunk
FROM mc.arch_texts t
JOIN version v ON v.archon_sha = t.archon_sha AND v.factory_sha = t.factory_sha
JOIN step s ON s.command_file = t.path
JOIN (VALUES (0), (1), (2), (3), (4), (5), (6), (7), (8), (9), (10), (11), (12), (13), (14), (15), (16), (17), (18), (19), (20), (21), (22), (23), (24)) AS n(part)
  ON n.part * 4000 < length(t.text)
