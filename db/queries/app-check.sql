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
  LEFT JOIN mc.lap_steps sel ON sel.run_id = s.run_id AND sel.step_id = 'select'
    AND l.workflow_name = 'factory-app-check'
  WHERE l.factory = pr.factory
    AND (s.step_id = 'check-app' OR (s.step_id = 'check' AND l.workflow_name = 'factory-app-check'))
    AND substring(coalesce(s.output ->> 'pr', sel.output ->> 'pr') FROM '([0-9]+)/?$')::integer
      = pr.number
  ORDER BY s.started_at DESC NULLS LAST, s.run_id LIMIT 1
) latest ON true
LEFT JOIN mc.app_check_lines a ON a.run_id = latest.run_id
WHERE pr.factory = $1 AND pr.state = 'open'
GROUP BY pr.number, pr.title, pr.url, latest.run_id, latest.overall
ORDER BY pr.number
