SELECT 'issue' AS kind, i.number AS issue_number, NULL::integer AS question_number,
  i.title, i.url, NULL::text AS options, NULL::text AS recommendation,
  NULL::text AS default_option, NULL::timestamptz AS default_at,
  -- Since it was labelled. Where that time was never recorded, since GitHub last changed it
  -- (labelling one changes it), which a later comment or edit moves, so that wait is approximate.
  coalesce(l.labeled_at, i.updated_at) AS waiting_since,
  l.labeled_at IS NULL AS approximate
FROM mc.issues i
JOIN mc.issue_labels l
  ON l.factory = i.factory AND l.issue_number = i.number AND l.label = 'needs-owner'
WHERE i.factory = $1 AND i.state = 'open'
UNION ALL
-- Each open question in the manager's `Owner decisions needed` issue. Options go as text and the
-- browser parses the JSON.
SELECT 'question', q.issue_number, q.question_number, q.question, i.url, q.options::text,
  q.recommendation, q.default_option, q.default_at, q.raised_at, false
FROM mc.owner_questions q
LEFT JOIN mc.issues i ON i.factory = q.factory AND i.number = q.issue_number
WHERE q.factory = $1 AND q.closed_at IS NULL
