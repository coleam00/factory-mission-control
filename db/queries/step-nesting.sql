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
-- The nodes beneath the step in its workflow. Each opens its own place in that workflow: an
-- include's copies repeat the definition, so the declared rows still answer for them.
SELECT s.path, s.position, s.step_id, s.kind
FROM mc.arch_steps s
JOIN version v ON v.archon_sha = s.archon_sha AND v.factory_sha = s.factory_sha
WHERE s.workflow = $2 AND starts_with(s.path, $3 || '/')
