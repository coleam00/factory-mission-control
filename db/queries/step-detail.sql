WITH queues AS (
  -- A factory on the queues has run a workflow only the queue pack has (home-map.sql's queues
  -- row). Its runs follow no pin, so its current version is the architecture parsed last (#435).
  SELECT EXISTS (SELECT 1 FROM mc.laps l
    WHERE l.factory = $1 AND l.workflow_name IN ('archon-intake', 'archon-build-queue')) AS on_queues
),
version AS (
  -- The version the address names by its pin, $2, or for '' the current version: on a factory on
  -- the queues the architecture parsed last, pinned or not, on any other the architecture of the
  -- newest pin that has any.
  SELECT a.archon_sha, a.factory_sha, a.parsed_at, p.sha AS pin
  FROM mc.arch_versions a
  JOIN mc.factories f ON f.name = $1
  CROSS JOIN queues q
  LEFT JOIN mc.pins p ON p.archon_sha = a.archon_sha
  WHERE CASE WHEN $2 = '' THEN q.on_queues OR p.sha IS NOT NULL ELSE p.sha = $2 END
  ORDER BY CASE WHEN $2 = '' AND q.on_queues THEN a.parsed_at END DESC NULLS LAST,
    p.committed_at DESC NULLS LAST, a.parsed_at DESC
  LIMIT 1
)
-- Each node in the workflow that declares it. A step an include expands is the same definition
-- again, so the browser finds the step at any place from these rows (`placeOf`, step-detail.ts).
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
  s.child_workflow,
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
