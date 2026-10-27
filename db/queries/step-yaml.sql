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
  SELECT s.defined_in
  FROM mc.arch_steps s
  JOIN version v ON v.archon_sha = s.archon_sha AND v.factory_sha = s.factory_sha
  WHERE s.workflow = $2 AND s.path = $3
)
-- The YAML of the workflow that defines the step, in parts as in step-prompt.sql.
SELECT w.name, w.file, n.part, substr(w.yaml, n.part * 4000 + 1, 4000) AS chunk
FROM mc.arch_workflows w
JOIN version v ON v.archon_sha = w.archon_sha AND v.factory_sha = w.factory_sha
JOIN step s ON s.defined_in = w.name
JOIN (VALUES (0), (1), (2), (3), (4), (5), (6), (7), (8), (9), (10), (11), (12), (13), (14), (15), (16), (17), (18), (19), (20), (21), (22), (23), (24)) AS n(part)
  ON n.part * 4000 < length(w.yaml)
