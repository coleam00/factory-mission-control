WITH lap AS (
  SELECT l.started_at, l.workflow_name FROM mc.laps l
  WHERE l.factory = $1 AND l.run_id::text = $2
),
-- The run's workflow at the run's own pin: the newest pin with stored architecture committed before the lap
-- started (a lap not started yet takes the newest). A lap older than every stored architecture
-- (north-star's first laps) takes the oldest, and the steps that map lacks are drawn beside it.
-- Only a version that holds the lap's workflow can draw it: the queue pack's build workflow lives
-- in its own version, which no pin names, so its pin is null and the step pages address it by archon_sha.
-- A version no pin names is drawn only on a factory on the queues, and there it is preferred over a pinned one; among versions of one pin the newest parse wins, as on the step pages.
queues AS (
  -- A factory on the queues has run a workflow only the queue pack has (home-map.sql's queues
  -- row). Copied from step-detail.sql, which owns it, and version-rule.test.ts fails a copy that differs.
  SELECT EXISTS (SELECT 1 FROM mc.laps l
    WHERE l.factory = $1 AND l.workflow_name IN ('archon-intake', 'archon-build-queue')) AS on_queues
),
version AS (
  SELECT a.archon_sha, a.factory_sha, p.sha AS pin
  FROM lap
  CROSS JOIN queues q
  CROSS JOIN mc.arch_versions a
  LEFT JOIN mc.pins p ON p.archon_sha = a.archon_sha
  WHERE EXISTS (SELECT 1 FROM mc.arch_steps s
    WHERE s.archon_sha = a.archon_sha AND s.factory_sha = a.factory_sha AND s.workflow = lap.workflow_name)
    AND (q.on_queues OR p.sha IS NOT NULL)
  ORDER BY (q.on_queues AND p.sha IS NULL) DESC,
    p.committed_at <= coalesce(lap.started_at, 'infinity'::timestamptz) DESC NULLS LAST,
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
SELECT v.pin, v.archon_sha, s.path, s.parent_path, s.position, s.step_id, s.kind, s.depends_on,
  s.when_condition, s.trigger_rule, s.round_cap
FROM steps s
CROSS JOIN version v
