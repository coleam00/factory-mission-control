WITH lap AS (
  SELECT l.started_at, l.workflow_name FROM mc.laps l
  WHERE l.factory = $1 AND l.run_id::text = $2
),
-- The run's workflow at the run's own pin: the newest pin with stored architecture committed before the lap
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
  SELECT s.path, s.parent_path, s.position, s.step_id, s.kind, s.depends_on,
    s.when_condition, s.trigger_rule, s.round_cap
  FROM mc.arch_steps s
  JOIN version v ON v.archon_sha = s.archon_sha AND v.factory_sha = s.factory_sha
  JOIN lap ON lap.workflow_name = s.workflow
)
-- Every node of the workflow's expanded tree, and each opens its own place in it.
SELECT v.pin, s.path, s.parent_path, s.position, s.step_id, s.kind, s.depends_on,
  s.when_condition, s.trigger_rule, s.round_cap
FROM steps s
CROSS JOIN version v
