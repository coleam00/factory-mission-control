SELECT 'issue' AS kind, i.number AS issue_number, i.title, i.url, NULL::uuid AS run_id
FROM mc.issues i
-- Workable: open, not labelled needs-owner, every `Depends on` closed (one that is not mirrored
-- is not known to be closed) and no live claim, one not yet released. The manager's two tracking
-- issues, kept by exact title, are never work a lap picks (#247).
WHERE i.factory = $1 AND i.state = 'open'
  AND i.title NOT IN ('Owner decisions needed', 'Loop metrics')
  AND NOT EXISTS (
    SELECT 1 FROM mc.issue_labels lb
    WHERE lb.factory = i.factory AND lb.issue_number = i.number AND lb.label = 'needs-owner'
  )
  AND NOT EXISTS (
    SELECT 1 FROM mc.issue_dependencies d
    WHERE d.factory = i.factory AND d.issue_number = i.number AND NOT EXISTS (
      SELECT 1 FROM mc.issues di
      WHERE di.factory = d.factory AND di.number = d.depends_on AND di.state = 'closed'
    )
  )
  AND NOT EXISTS (
    SELECT 1 FROM mc.claims c
    WHERE c.factory = i.factory AND c.issue_number = i.number AND c.released_at IS NULL
  )
UNION ALL
-- The running laps the workable issues are set against.
SELECT 'lap', NULL, NULL, NULL, l.run_id
FROM mc.laps l
WHERE l.factory = $1 AND l.workflow_name = 'archon-loop' AND l.status = 'running'
