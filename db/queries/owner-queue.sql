SELECT 'issue' AS kind, i.number AS issue_number, NULL::integer AS question_number,
  i.title, i.url, NULL::text AS options, NULL::text AS recommendation,
  NULL::text AS default_option, NULL::timestamptz AS default_at,
  -- No row records when an issue was labelled, so it has waited since GitHub last changed it
  -- (labelling one changes it).
  i.updated_at AS waiting_since
FROM mc.issues i
WHERE i.factory = $1 AND i.state = 'open' AND EXISTS (
  SELECT 1 FROM mc.issue_labels l
  WHERE l.factory = i.factory AND l.issue_number = i.number AND l.label = 'needs-owner'
)
UNION ALL
-- Each open question in the manager's `Owner decisions needed` issue. Options go as text and the
-- browser parses the JSON.
SELECT 'question', q.issue_number, q.question_number, q.question, i.url, q.options::text,
  q.recommendation, q.default_option, q.default_at, q.raised_at
FROM mc.owner_questions q
LEFT JOIN mc.issues i ON i.factory = q.factory AND i.number = q.issue_number
WHERE q.factory = $1 AND q.closed_at IS NULL
