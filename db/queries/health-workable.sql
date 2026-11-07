SELECT 'issue' AS kind, i.number AS issue_number, i.title, i.url, NULL::uuid AS run_id
FROM mc.issues i
-- Workable: open, not labelled needs-owner, every `Depends on` closed (one that is not mirrored
-- is not known to be closed), no live claim, one not yet released, and not parked by the queues as
-- the Board reads it. The manager's two tracking
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
  -- Not parked: the Board's parked rule (`parked` in app/lib/board.ts), restated because a live
  -- query may call no mc function. db/queries/restated-rules.test.ts fails when the two disagree.
  AND NOT EXISTS (
    SELECT 1 FROM mc.work_item_states w
    JOIN mc.factories f ON f.codebase = w.project_key
    WHERE f.name = i.factory AND w.number = i.number AND (
      w.build_status = 'parked' AND NOT coalesce(w.triage_at > w.build_at, false)
      OR w.build_status IS DISTINCT FROM 'parked' AND w.merge_status = 'parked'
        AND NOT coalesce(w.triage_at > w.merge_at, false)
        AND (w.build_status IS NULL AND w.own_pr_at IS NOT NULL
          OR NOT coalesce(CASE WHEN w.build_status = 'ready' THEN w.build_at ELSE w.own_pr_at END > w.merge_at, false))
    )
  )
UNION ALL
-- The running laps the workable issues are set against.
SELECT 'lap', NULL, NULL, NULL, l.run_id
FROM mc.laps l
WHERE l.factory = $1 AND l.workflow_name = 'archon-loop' AND l.status = 'running'
