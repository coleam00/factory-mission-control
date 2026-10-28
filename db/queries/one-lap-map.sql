WITH lap AS (
  SELECT l.started_at FROM mc.laps l
  WHERE l.factory = $1 AND l.run_id::text = $2 AND l.workflow_name = 'archon-loop'
),
-- The loop at the lap's own pin: the newest pin with stored architecture committed before the lap
-- started (a lap not started yet takes the newest). A lap older than every stored architecture
-- (north-star's first laps) takes the oldest, and the steps that map lacks are drawn beside it.
version AS (
  SELECT a.archon_sha, a.factory_sha, p.sha AS pin
  FROM lap
  CROSS JOIN mc.pins p
  JOIN mc.arch_versions a ON a.archon_sha = p.archon_sha
  ORDER BY p.committed_at <= coalesce(lap.started_at, 'infinity'::timestamptz) DESC,
    CASE WHEN p.committed_at <= coalesce(lap.started_at, 'infinity'::timestamptz)
      THEN p.committed_at END DESC NULLS LAST,
    p.committed_at, a.parsed_at DESC
  LIMIT 1
),
steps AS (
  SELECT s.path, s.parent_path, s.position, s.step_id, s.kind, s.depends_on, s.include,
    s.defined_in, s.workflow, s.when_condition, s.trigger_rule
  FROM mc.arch_steps s
  JOIN version v ON v.archon_sha = s.archon_sha AND v.factory_sha = s.factory_sha
  WHERE s.workflow = 'archon-loop'
)
-- Every node of the loop's expanded tree, with where its own screen is, as home-map.sql gives it:
-- under the workflow that declares it, at its path there.
SELECT v.pin, s.path, s.parent_path, s.position, s.step_id, s.kind, s.depends_on,
  s.when_condition, s.trigger_rule,
  coalesce(s.defined_in, s.workflow) AS detail_workflow,
  CASE WHEN i.path IS NULL THEN s.path ELSE substr(s.path, length(i.path) + 2) END AS detail_path
FROM steps s
CROSS JOIN version v
LEFT JOIN steps i
  ON s.defined_in <> s.workflow AND i.include = s.defined_in AND starts_with(s.path, i.path || '/')
