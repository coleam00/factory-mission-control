SELECT 'attention' AS kind, a.run_id, NULL::integer AS issue_number, NULL::integer AS question_number
FROM mc.attention_items a
JOIN mc.factories f ON f.name = a.factory
WHERE a.factory = $1
UNION ALL
-- One row per open item the Decisions screen shows, for its tab's count. Each part has the WHERE of
-- the query the screen reads (attention-items and owner-queue), and decisions.test.ts holds the
-- row count equal to theirs.
SELECT 'issue', NULL::uuid, i.number, NULL::integer
FROM mc.issues i
JOIN mc.issue_labels l
  ON l.factory = i.factory AND l.issue_number = i.number AND l.label = 'needs-owner'
WHERE i.factory = $1 AND i.state = 'open'
UNION ALL
SELECT 'question', NULL::uuid, q.issue_number, q.question_number
FROM mc.owner_questions q
WHERE q.factory = $1 AND q.closed_at IS NULL
