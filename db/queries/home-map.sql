WITH version AS (
  SELECT a.archon_sha, a.factory_sha
  FROM mc.arch_versions a
  JOIN mc.pins p ON p.archon_sha = a.archon_sha
  -- Like the version strip, an empty factory does not borrow the shared pin history.
  WHERE EXISTS (SELECT 1 FROM mc.laps l WHERE l.factory = $1)
  ORDER BY p.committed_at DESC, a.parsed_at DESC
  LIMIT 1
),
-- Every node of each shown workflow's expanded tree, at every depth an include or loop group nests.
steps AS (
  SELECT s.workflow, s.path, s.parent_path, s.position, s.step_id, s.kind, s.depends_on, s.include,
    s.defined_in, s.when_condition, s.trigger_rule
  FROM mc.arch_steps s
  JOIN version v ON v.archon_sha = s.archon_sha AND v.factory_sha = s.factory_sha
  WHERE s.workflow IN ('archon-holdouts', 'archon-backlog', 'archon-manager', 'archon-loop')
),
-- Where each node's own screen is: under the workflow that declares it, at its path there. A node
-- an include expanded sits beneath exactly one include of that workflow (the parser refuses an
-- include cycle), and its own path is what follows that include's path.
own AS (
  SELECT s.workflow, s.path, s.parent_path, s.position, s.step_id, s.kind, s.depends_on,
    s.defined_in, s.when_condition, s.trigger_rule,
    CASE WHEN i.path IS NULL THEN s.path ELSE substr(s.path, length(i.path) + 2) END AS own_path
  FROM steps s
  LEFT JOIN steps i
    ON s.defined_in <> s.workflow AND i.workflow = s.workflow AND i.include = s.defined_in
    AND starts_with(s.path, i.path || '/')
),
running AS (
  SELECT l.factory, l.workflow_name, ls.run_id, ls.step_id
  FROM mc.lap_steps ls
  JOIN mc.laps l ON l.run_id = ls.run_id
  WHERE l.status = 'running' AND ls.status = 'running'
),
-- Archon names a nested step by its path joined with `__` (`ship__intel`) and emits no event for
-- the step that includes it, so a node counts its workflow's runs on it or anywhere beneath it,
-- per factory.
on_node AS (
  SELECT s.workflow, s.path, r.factory, count(DISTINCT r.run_id)::int AS laps
  FROM steps s
  JOIN running r
    ON r.workflow_name = s.workflow
    AND (r.step_id = replace(s.path, '/', '__')
      OR starts_with(r.step_id, replace(s.path, '/', '__') || '__'))
  GROUP BY s.workflow, s.path, r.factory
)
-- A node has one row per factory with laps on it, or one row with no factory when none has.
-- `is_current` marks the factory in the address.
SELECT
  CASE
    WHEN w.name = 'archon-manager' THEN 'manager'
    WHEN w.name <> 'archon-loop' THEN 'input'
    WHEN s.parent_path IS NULL THEN 'step'
    ELSE 'stage'
  END AS role,
  w.name AS workflow,
  s.path,
  s.parent_path,
  s.position,
  s.step_id,
  s.kind,
  s.depends_on,
  s.when_condition,
  s.trigger_rule,
  coalesce(s.defined_in, w.name) AS detail_workflow,
  s.own_path AS detail_path,
  c.factory AS lap_factory,
  coalesce(c.laps, 0) AS laps,
  coalesce(c.factory = $1, false) AS is_current
FROM mc.arch_workflows w
JOIN version v ON v.archon_sha = w.archon_sha AND v.factory_sha = w.factory_sha
LEFT JOIN own s ON s.workflow = w.name
LEFT JOIN on_node c ON c.workflow = s.workflow AND c.path = s.path
WHERE w.name IN ('archon-holdouts', 'archon-backlog', 'archon-manager', 'archon-loop')
