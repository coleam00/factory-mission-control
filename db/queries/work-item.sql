WITH runs AS (
  -- Every run on work item $2 (a number as text: a malformed one in the address is no work item,
  -- not a failed query). An old-loop lap by its claim or number input, a build-queue lap by its
  -- facts step naming the item (PRD 4.2's lap rule, #378), or a build-queue run on the item by
  -- number input whose facts step has not finished yet, an intake run by its number input or the
  -- item its outcome step names.
  SELECT l.run_id, l.workflow_name, l.status, l.started_at, l.completed_at, l.attention_open,
    EXISTS (SELECT 1 FROM mc.lap_steps f WHERE f.run_id = l.run_id AND f.step_id = 'facts'
      AND f.output -> 'item' ->> 'number' = $2) AS lap
  FROM mc.laps l
  WHERE l.factory = $1 AND (
    (l.workflow_name = 'archon-loop' AND (l.issue_number::text = $2 OR EXISTS (
      SELECT 1 FROM mc.claims c
      WHERE c.factory = l.factory AND c.run_id = l.run_id AND c.issue_number::text = $2)))
    OR (l.workflow_name = 'archon-build-queue' AND (EXISTS (
      SELECT 1 FROM mc.lap_steps f WHERE f.run_id = l.run_id AND f.step_id = 'facts'
        AND f.output -> 'item' ->> 'number' = $2)
      OR (l.issue_number::text = $2 AND l.completed_at IS NULL AND NOT EXISTS (
        SELECT 1 FROM mc.lap_steps f
        WHERE f.run_id = l.run_id AND f.step_id = 'facts' AND f.status = 'completed'))))
    OR (l.workflow_name = 'archon-intake' AND (l.issue_number::text = $2 OR EXISTS (
      SELECT 1 FROM mc.lap_steps o WHERE o.run_id = l.run_id AND o.step_id = 'outcome'
        AND o.output ->> 'item' = $2)))
  )
)
-- The item row: status is the issue's state, started_at its creation and completed_at its closing.
SELECT 'item' AS kind, NULL::uuid AS run_id, NULL::text AS workflow, i.state AS status,
  i.created_at AS started_at, i.closed_at AS completed_at, NULL::boolean AS lap,
  NULL::boolean AS waiting, NULL::float8 AS cost, NULL::text[] AS steps,
  NULL::text AS failed_step, NULL::text AS error, NULL::text AS route, NULL::text AS depth,
  NULL::jsonb AS labels, NULL::text AS deliveries, NULL::text AS review,
  NULL::timestamptz AS review_at, NULL::text AS rereview, NULL::timestamptz AS rereview_at,
  NULL::text AS check_overall, NULL::timestamptz AS check_at,
  NULL::text AS decision, NULL::text AS reason, NULL::timestamptz AS decision_at,
  NULL::text AS answer, NULL::text AS answer_summary, NULL::timestamptz AS answer_at,
  NULL::text AS line_kind, NULL::text AS line_verdict,
  NULL::integer AS pr, NULL::jsonb AS decisions, NULL::jsonb AS landed, NULL::text AS asked_pr,
  NULL::text AS record_status, i.number, i.title, i.url, f.console,
  NULL::text AS stop_step, NULL::text AS stop_line, NULL::text AS stop_class
FROM mc.issues i
JOIN mc.factories f ON f.name = i.factory
WHERE i.factory = $1 AND i.number::text = $2
UNION ALL
SELECT 'run', r.run_id, r.workflow_name, r.status, r.started_at, r.completed_at, r.lap,
  r.attention_open,
  (SELECT sum(a.cost_usd)::float8 FROM mc.lap_step_attempts a WHERE a.run_id = r.run_id),
  s.steps, fl.step_id, fl.error,
  pick.output ->> 'route', pick.output ->> 'depth', outcome.output -> 'labels',
  rnd.output ->> 'round',
  coalesce(rv.output ->> 'outcome', vr.output ->> 'action', vp.output ->> 'action'),
  coalesce(rv.completed_at, vr.completed_at, vp.completed_at), rr.output ->> 'action', rr.completed_at,
  chk.output ->> 'overall', chk.completed_at,
  coalesce(land.output ->> 'outcome', apply.output ->> 'decision'),
  coalesce(land.output ->> 'reason', answer.output ->> 'reason', route.output ->> 'reason'),
  coalesce(land.completed_at, apply.completed_at),
  ruling.output ->> 'decision', ruling.output ->> 'summary', ruling.completed_at,
  NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
  st.step_id, st.line, st.class
FROM runs r
LEFT JOIN LATERAL (
  SELECT array_agg(ls.step_id ORDER BY ls.started_at DESC NULLS LAST, ls.step_id) AS steps
  FROM mc.lap_steps ls WHERE ls.run_id = r.run_id AND ls.status = 'running'
) s ON true
LEFT JOIN LATERAL (
  SELECT ls.step_id, ls.error FROM mc.lap_steps ls
  WHERE ls.run_id = r.run_id AND ls.status = 'failed'
  ORDER BY ls.completed_at DESC NULLS LAST, ls.step_id LIMIT 1
) fl ON true
LEFT JOIN mc.lap_steps pick ON pick.run_id = r.run_id AND pick.step_id = 'pick'
LEFT JOIN mc.lap_steps rv ON rv.run_id = r.run_id AND rv.step_id = 'review'
LEFT JOIN mc.lap_steps chk ON chk.run_id = r.run_id AND chk.step_id = 'check-app'
LEFT JOIN mc.lap_steps land ON land.run_id = r.run_id AND land.step_id = 'land'
LEFT JOIN mc.lap_steps outcome ON outcome.run_id = r.run_id AND outcome.step_id = 'outcome'
  AND r.workflow_name = 'archon-intake'
LEFT JOIN mc.lap_steps rnd ON rnd.run_id = r.run_id AND rnd.step_id = 'ship__deliver__rounds.round'
LEFT JOIN mc.lap_steps vr ON vr.run_id = r.run_id AND vr.status = 'completed'
  AND vr.step_id = 'ship__deliver__rounds.review__result'
LEFT JOIN mc.lap_steps vp ON vp.run_id = r.run_id AND vp.status = 'completed'
  AND vp.step_id = 'ship__deliver__rounds.review__publish'
LEFT JOIN mc.lap_steps rr ON rr.run_id = r.run_id AND rr.status = 'completed'
  AND rr.step_id = 'ship__deliver__rounds.rereview__result'
LEFT JOIN mc.lap_steps route ON route.run_id = r.run_id AND route.step_id = 'route'
  AND r.workflow_name = 'archon-build-queue'
LEFT JOIN mc.lap_steps answer ON answer.run_id = r.run_id AND answer.step_id = 'answer'
LEFT JOIN mc.lap_steps apply ON apply.run_id = r.run_id AND apply.step_id = 'apply'
LEFT JOIN mc.lap_steps ruling ON ruling.run_id = r.run_id AND ruling.step_id = 'ruling'
LEFT JOIN mc.run_stops st ON st.run_id = r.run_id
UNION ALL
-- An old-loop lap's app check lines, each by kind and verdict (the browser counts them), never a
-- line's text, and never a holdout line (MISSION rule 3).
SELECT 'line', a.run_id, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
  NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
  NULL, NULL, a.kind, a.verdict, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
  NULL, NULL, NULL
FROM runs r
JOIN mc.app_check_lines a ON a.run_id = r.run_id
WHERE a.kind <> 'holdout'
UNION ALL
-- Each queue sweep that ran while one of the item's pull requests was open, with that sweep's
-- decisions and the pull requests its record step read back as merged, and the browser keeps the
-- decision whose number is this pull request's, and drops a sweep that has none.
SELECT 'sweep', l.run_id, l.workflow_name, l.status, l.started_at, l.completed_at, NULL,
  l.attention_open, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
  NULL, NULL, NULL, sw.completed_at, ruling.output ->> 'decision', ruling.output ->> 'summary',
  ruling.completed_at, NULL, NULL, p.pr_number, sw.output -> 'decisions',
  rec.output -> 'merged', rec.output -> 'asked' -> 'pr' ->> 'number', rec.status, NULL, NULL, NULL, NULL,
  NULL, NULL, NULL
FROM mc.pull_request_issues p
JOIN mc.pull_requests pr ON pr.factory = p.factory AND pr.number = p.pr_number
JOIN mc.laps l ON l.factory = p.factory
JOIN mc.lap_steps sw ON sw.run_id = l.run_id AND sw.step_id = 'sweep' AND sw.status = 'completed'
  AND sw.completed_at >= pr.created_at AND (pr.closed_at IS NULL OR sw.started_at <= pr.closed_at)
LEFT JOIN mc.lap_steps rec ON rec.run_id = l.run_id AND rec.step_id = 'record'
LEFT JOIN mc.lap_steps ruling ON ruling.run_id = l.run_id AND ruling.step_id = 'ruling'
WHERE p.factory = $1 AND p.issue_number::text = $2
