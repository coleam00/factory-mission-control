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
)
-- The hooks that apply to the step: each lets one of the step's subagents through, the holdout
-- fence around the agents that may read the scenarios.
SELECT h.path, h.admitted_agents, g.workflow, g.step_path, g.name AS agent, g.description
FROM mc.arch_hooks h
JOIN version v ON v.archon_sha = h.archon_sha AND v.factory_sha = h.factory_sha
JOIN mc.arch_subagents g
  ON g.archon_sha = h.archon_sha AND g.factory_sha = h.factory_sha
  AND g.name = ANY (h.admitted_agents)
WHERE g.workflow = $2 AND g.step_path = $3
