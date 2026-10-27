SELECT
  -- The newest `holdouts at <sha>:` line's verdicts: scenario id, verdict and tracking issue only.
  r.at, r.sha, r.issue_number AS report_issue, v.scenario_id, v.verdict, v.issue_number,
  i.title AS issue_title, i.state AS issue_state, i.url AS issue_url
FROM mc.holdout_reports r
JOIN mc.holdout_verdicts v ON v.report_id = r.id
LEFT JOIN mc.issues i ON i.factory = r.factory AND i.number = v.issue_number
WHERE r.factory = $1
  AND NOT EXISTS (SELECT 1 FROM mc.holdout_reports n WHERE n.factory = r.factory AND n.at > r.at)
