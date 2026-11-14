SELECT 'issue' AS kind, i.number AS issue_number, i.title, i.url, NULL::uuid AS run_id
FROM mc.issues i
-- Workable: open, not labelled needs-owner, every `Depends on` gone as unstick.sql reads it: a closed issue or a
-- closed or merged pull request (one that is not mirrored is not known to be gone), no live claim, one not yet released, not held by a running run, and not parked by the queues as
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
    WHERE d.factory = i.factory AND d.issue_number = i.number
      AND NOT EXISTS (SELECT 1 FROM mc.issues di WHERE di.factory = d.factory AND di.number = d.depends_on AND di.state = 'closed')
      AND NOT EXISTS (SELECT 1 FROM mc.pull_requests dr WHERE dr.factory = d.factory AND dr.number = d.depends_on AND dr.state = 'closed')
  )
  AND NOT EXISTS (
    SELECT 1 FROM mc.claims c
    WHERE c.factory = i.factory AND c.issue_number = i.number AND c.released_at IS NULL
  )
  -- Not held by a running run: the run's claim, else its facts step's item, else its number input
  -- (the rule runs.sql and home-map.sql read, but a split run holds nothing, as it only slices an item into children, so the item stays workable.
  -- Restated because a live query may call no mc function. db/queries/restated-rules.test.ts fails when they and board.sql's rounds disagree).
  AND NOT EXISTS (
    SELECT 1 FROM mc.laps l
    LEFT JOIN LATERAL (
      SELECT c.issue_number FROM mc.claims c
      WHERE c.factory = l.factory AND c.run_id = l.run_id
      ORDER BY c.claimed_at DESC NULLS LAST, c.issue_number LIMIT 1
    ) c ON true
    LEFT JOIN mc.lap_steps facts ON facts.run_id = l.run_id AND facts.step_id = 'facts'
    WHERE l.factory = i.factory AND l.status = 'running' AND l.workflow_name <> 'archon-split'
      AND coalesce(c.issue_number, (facts.output -> 'item' ->> 'number')::int, l.issue_number) = i.number
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
        AND NOT coalesce(w.build_status = 'ready' AND w.build_at > w.merge_at, false)
    )
  )
UNION ALL
-- The running laps the workable issues are set against.
SELECT 'lap', NULL, NULL, NULL, l.run_id
FROM mc.laps l
WHERE l.factory = $1 AND l.workflow_name = 'archon-loop' AND l.status = 'running'
