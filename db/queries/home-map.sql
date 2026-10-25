WITH version AS (
  SELECT a.archon_sha, a.factory_sha
  FROM mc.arch_versions a
  JOIN mc.pins p ON p.archon_sha = a.archon_sha
  ORDER BY p.committed_at DESC, a.parsed_at DESC
  LIMIT 1
),
expanded AS (
  SELECT s.path, s.include
  FROM mc.arch_steps s
  JOIN version v ON v.archon_sha = s.archon_sha AND v.factory_sha = s.factory_sha
  WHERE s.workflow = 'archon-loop' AND s.parent_path IS NULL AND s.include = 'archon-ship-block'
),
on_step AS (
  SELECT ls.step_id, count(DISTINCT ls.run_id)::int AS laps
  FROM mc.lap_steps ls
  JOIN mc.laps l ON l.run_id = ls.run_id
  WHERE l.factory = $1 AND l.workflow_name = 'archon-loop' AND l.status = 'running'
    AND ls.status = 'running'
  GROUP BY ls.step_id
)
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
  coalesce(e.include, w.name) AS detail_workflow,
  coalesce(c.laps, 0) AS live_count
FROM mc.arch_workflows w
JOIN version v ON v.archon_sha = w.archon_sha AND v.factory_sha = w.factory_sha
LEFT JOIN mc.arch_steps s
  ON w.name = 'archon-loop' AND s.archon_sha = w.archon_sha AND s.factory_sha = w.factory_sha
  AND s.workflow = w.name
LEFT JOIN expanded e ON e.path = s.parent_path
LEFT JOIN on_step c ON c.step_id = s.step_id
WHERE w.name IN ('archon-holdouts', 'archon-backlog', 'archon-manager', 'archon-loop')
  AND (w.name <> 'archon-loop' OR s.parent_path IS NULL OR e.path IS NOT NULL)
