SELECT 'issue' AS kind, i.number, i.title, i.phase, i.url,
  CASE
    WHEN i.state = 'closed' AND EXISTS (
      SELECT 1 FROM mc.pull_request_issues pi
      JOIN mc.pull_requests p ON p.factory = pi.factory AND p.number = pi.pr_number
      WHERE pi.factory = i.factory AND pi.issue_number = i.number AND p.merged_at IS NOT NULL
    ) THEN 'merged'
    WHEN i.state = 'closed' THEN 'closed'
    WHEN EXISTS (
      SELECT 1 FROM mc.issue_labels l
      WHERE l.factory = i.factory AND l.issue_number = i.number AND l.label = 'needs-owner'
    ) THEN 'needs-owner'
    WHEN EXISTS (
      SELECT 1 FROM mc.pull_request_issues pi
      JOIN mc.pull_requests p ON p.factory = pi.factory AND p.number = pi.pr_number
      WHERE pi.factory = i.factory AND pi.issue_number = i.number AND p.state = 'open'
    ) THEN 'pr-open'
    WHEN EXISTS (
      SELECT 1 FROM mc.claims c
      WHERE c.factory = i.factory AND c.issue_number = i.number AND c.released_at IS NULL
    ) THEN 'claimed'
    ELSE 'waiting'
  END AS state,
  NULL::integer AS depends_on
FROM mc.issues i
WHERE i.factory = $1
UNION ALL
SELECT 'edge', d.issue_number, NULL, NULL, NULL, NULL, d.depends_on
FROM mc.issue_dependencies d
WHERE d.factory = $1
