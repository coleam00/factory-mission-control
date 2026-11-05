SELECT * FROM (
  -- What the gate card and the Staging cards list as live (PRD 4.1): recent gate decisions and the
  -- latest deploy. Its own feed, so a refusal here leaves the map drawn (the home-map query blanks it).
  -- Kept apart from the shared columns of home-map: none of its other kinds has these.
  -- Decisions, merged pull requests and the facts items come as JSON text, which the browser expands,
  -- as home-map's prs.
  -- A run that swept and then recorded: the sweep's decisions, the pull requests the record step
  -- read back as landed, the one it asked about, and the facts step's items, which carry the numbers the run claimed. Only these
  -- steps exist in that queue, so they identify the run, and its workflow name is never read.
  SELECT 'outcomes' AS kind, l.run_id,
    coalesce(rec.completed_at, rec.started_at + rec.duration_ms * interval '1 millisecond') AS at,
    (sw.output -> 'decisions')::text AS decisions,
    (rec.output -> 'merged')::text AS merged,
    rec.output -> 'asked' -> 'pr' ->> 'number' AS asked,
    (fa.output -> 'items')::text AS claimed,
    NULL::text AS revision, NULL::text AS health, NULL::text AS status, f.repository
  FROM mc.laps l
  JOIN mc.factories f ON f.name = l.factory
  JOIN mc.lap_steps rec ON rec.run_id = l.run_id AND rec.step_id = 'record'
    AND rec.status = 'completed' AND rec.output -> 'merged' IS NOT NULL
  JOIN mc.lap_steps fa ON fa.run_id = l.run_id AND fa.step_id = 'facts'
    AND fa.status = 'completed' AND jsonb_typeof(fa.output -> 'items') = 'array'
  JOIN mc.lap_steps sw ON sw.run_id = l.run_id AND sw.step_id = 'sweep'
    AND sw.status = 'completed' AND sw.output -> 'decisions' IS NOT NULL
  WHERE l.factory = $1
  ORDER BY 3 DESC NULLS LAST, l.run_id
  LIMIT 10
) gate
UNION ALL
-- The newest finished deploy run: the revision it served, what health said, and whether verify passed.
SELECT * FROM (
  SELECT 'deploys', l.run_id, coalesce(l.completed_at, l.started_at),
    NULL::text, NULL::text, NULL::text, NULL::text,
    coalesce(dep.output ->> 'deployed_revision', pre.output ->> 'revision'),
    dep.output ->> 'health_status',
    CASE WHEN ver.status = 'completed' THEN 'verified' ELSE 'failed' END,
    f.repository
  FROM mc.laps l
  JOIN mc.factories f ON f.name = l.factory
  LEFT JOIN mc.lap_steps pre ON pre.run_id = l.run_id AND pre.step_id = 'preflight'
  LEFT JOIN mc.lap_steps dep ON dep.run_id = l.run_id AND dep.step_id = 'deploy'
  LEFT JOIN mc.lap_steps ver ON ver.run_id = l.run_id AND ver.step_id = 'verify'
  WHERE l.factory = $1 AND l.workflow_name = 'factory-deploy' AND l.status IN ('completed', 'failed')
  ORDER BY 3 DESC NULLS LAST, l.run_id
  LIMIT 1
) staged
UNION ALL
-- The newest old-loop lap whose deploy include finished: its verify step's revision, and health's ok
-- (not reported when the deploy step failed). 'verified' needs a revision read back, 'deployed' had none.
SELECT * FROM (
  SELECT 'deploys', l.run_id, coalesce(ver.completed_at, ver.started_at),
    NULL::text, NULL::text, NULL::text, NULL::text,
    ver.output ->> 'revision',
    CASE WHEN dp.output ->> 'ok' = 'false' THEN NULL
      ELSE CASE hl.output ->> 'ok' WHEN 'true' THEN 'healthy' WHEN 'false' THEN 'unhealthy' END END,
    CASE WHEN ver.output ->> 'deployed' <> 'true' OR ver.output ->> 'deployed' IS NULL THEN 'failed'
      WHEN coalesce(ver.output ->> 'observed', '') = '' THEN 'deployed'
      ELSE 'verified' END,
    f.repository
  FROM mc.laps l
  JOIN mc.factories f ON f.name = l.factory
  JOIN mc.lap_steps ver ON ver.run_id = l.run_id AND ver.step_id = 'deploy__verify'
    AND ver.status IN ('completed', 'failed')
  LEFT JOIN mc.lap_steps hl ON hl.run_id = l.run_id AND hl.step_id = 'deploy__health'
  LEFT JOIN mc.lap_steps dp ON dp.run_id = l.run_id AND dp.step_id = 'deploy__deploy'
  WHERE l.factory = $1 AND l.workflow_name = 'archon-loop'
  ORDER BY 3 DESC NULLS LAST, l.run_id
  LIMIT 1
) looped
