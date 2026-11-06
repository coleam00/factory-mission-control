SELECT
  -- Each open pull request the app check has looked at, with its latest check's verdict (none while
  -- it is still running) and its lines by kind. Never a line's text (invariant 3). $1 is the factory.
  pr.number, pr.title, pr.url, latest.run_id, latest.overall,
  count(a.*) FILTER (WHERE a.kind = 'criterion')::int AS criteria,
  count(a.*) FILTER (WHERE a.kind = 'probe')::int AS probes,
  count(a.*) FILTER (WHERE a.kind = 'assertion')::int AS assertions
FROM mc.pull_requests pr
JOIN LATERAL (
  SELECT s.run_id, s.output ->> 'overall' AS overall
  FROM mc.lap_steps s
  JOIN mc.laps l ON l.run_id = s.run_id
  LEFT JOIN mc.lap_steps sel ON sel.run_id = s.run_id
    AND ((l.workflow_name = 'factory-app-check' AND sel.step_id = 'select')
      OR (l.workflow_name = 'archon-loop' AND sel.step_id = 'subject'))
  WHERE l.factory = pr.factory
    AND (s.status = 'running' OR s.output ? 'overall')
    AND (s.step_id = 'check-app' OR (s.step_id = 'check' AND l.workflow_name = 'factory-app-check'))
    -- The pull request is the step's projected pr_number, or its select's when it has no pr text.
    AND CASE WHEN s.output ->> 'pr' IS NOT NULL THEN s.pr_number ELSE sel.pr_number END = pr.number
  ORDER BY s.started_at DESC NULLS LAST, s.run_id LIMIT 1
) latest ON true
LEFT JOIN mc.app_check_lines a ON a.run_id = latest.run_id
WHERE pr.factory = $1 AND pr.state = 'open'
GROUP BY pr.number, pr.title, pr.url, latest.run_id, latest.overall
ORDER BY pr.number
