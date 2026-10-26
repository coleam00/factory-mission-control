WITH version AS (
  -- The current version: the architecture of the newest pin that has any.
  SELECT a.archon_sha, a.factory_sha
  FROM mc.arch_versions a
  JOIN mc.pins p ON p.archon_sha = a.archon_sha
  JOIN mc.factories f ON f.name = $1
  ORDER BY p.committed_at DESC, a.parsed_at DESC
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
