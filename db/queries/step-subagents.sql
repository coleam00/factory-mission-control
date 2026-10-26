WITH version AS (
  -- The current version: the architecture of the newest pin that has any.
  SELECT a.archon_sha, a.factory_sha
  FROM mc.arch_versions a
  JOIN mc.pins p ON p.archon_sha = a.archon_sha
  JOIN mc.factories f ON f.name = $1
  ORDER BY p.committed_at DESC, a.parsed_at DESC
  LIMIT 1
)
-- The step's subagents, each with its instruction file in parts as in step-prompt.sql. An agent
-- without one is one row with no part text.
SELECT
  g.workflow,
  g.step_path,
  g.name,
  g.description,
  g.prompt,
  g.instruction_file,
  n.part,
  substr(t.text, n.part * 4000 + 1, 4000) AS chunk
FROM mc.arch_subagents g
JOIN version v ON v.archon_sha = g.archon_sha AND v.factory_sha = g.factory_sha
LEFT JOIN mc.arch_texts t
  ON t.archon_sha = g.archon_sha AND t.factory_sha = g.factory_sha AND t.path = g.instruction_file
JOIN (VALUES (0), (1), (2), (3), (4), (5), (6), (7), (8), (9), (10), (11), (12), (13), (14), (15), (16), (17), (18), (19), (20), (21), (22), (23), (24)) AS n(part)
  ON n.part = 0 OR n.part * 4000 < length(t.text)
WHERE g.workflow = $2 AND g.step_path = $3
