WITH version AS (
  -- The version the address names by its pin, $2, or for '' the current version: the
  -- architecture of the newest pin that has any.
  SELECT a.archon_sha, a.factory_sha
  FROM mc.arch_versions a
  JOIN mc.pins p ON p.archon_sha = a.archon_sha
  JOIN mc.factories f ON f.name = $1
  WHERE $2 = '' OR p.sha = $2
  ORDER BY p.committed_at DESC, a.parsed_at DESC
  LIMIT 1
)
-- Each node in the workflow that declares it: a step an include expands is the same definition
-- again, and its screen is the one under its own workflow.
SELECT
  s.workflow,
  s.path,
  s.parent_path,
  s.position,
  s.step_id,
  s.kind,
  s.description,
  s.model,
  s.when_condition,
  s.depends_on,
  s.trigger_rule,
  s.include,
  s.command_file,
  s.script,
  s.script_file,
  s.runtime,
  s.bash,
  s.prompt,
  s.defined_in,
  s.file
FROM mc.arch_steps s
JOIN version v ON v.archon_sha = s.archon_sha AND v.factory_sha = s.factory_sha
WHERE s.defined_in = s.workflow
