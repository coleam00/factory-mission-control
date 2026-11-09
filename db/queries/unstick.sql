SELECT 'blocked'::text AS kind, i.number, NULL::uuid AS run_id, NULL::text AS workflow_name,
  b.waits_on, b.since, 'retriage'::text AS action, f.repository, f.console
-- Work that stopped moving, with what it waits on, since when, and the one action that moves it.
-- `since` is when it became movable, not when it was first stuck. Four kinds, each keyed by $1.
-- Blocked: an open issue the queues stopped (stage 'blocked') whose every `Depends on` is closed or merged.
FROM mc.issues i
JOIN mc.factories f ON f.name = i.factory
JOIN mc.work_item_states w ON w.project_key = f.codebase AND w.number = i.number AND w.stage = 'blocked'
CROSS JOIN LATERAL (
  SELECT count(*) AS n, count(g.at) AS gone, max(g.at) AS since,
    array_to_string(array_agg('#' || d.depends_on ORDER BY d.depends_on), ', ') AS waits_on
  FROM mc.issue_dependencies d
  -- Gone: closed or merged. A number that is not mirrored is not known to be gone.
  LEFT JOIN LATERAL (
    SELECT max(x.at) AS at FROM (
      SELECT coalesce(p.merged_at, p.closed_at, p.updated_at) AS at
      FROM mc.pull_requests p
      WHERE p.factory = d.factory AND p.number = d.depends_on AND p.state = 'closed'
      UNION ALL
      SELECT coalesce(di.closed_at, di.updated_at)
      FROM mc.issues di
      WHERE di.factory = d.factory AND di.number = d.depends_on AND di.state = 'closed'
    ) x
  ) g ON true
  WHERE d.factory = i.factory AND d.issue_number = i.number
) b
WHERE i.factory = $1 AND i.state = 'open' AND b.n > 0 AND b.gone = b.n
UNION ALL
-- Parked: an open issue parked as the Board reads it whose ruling names only items that are closed or merged.
SELECT 'parked', i.number, NULL, NULL, b.waits_on, b.since, 'retriage', f.repository, f.console
FROM mc.issues i
JOIN mc.factories f ON f.name = i.factory
JOIN mc.work_item_states w ON w.project_key = f.codebase AND w.number = i.number
CROSS JOIN LATERAL (
  SELECT count(*) AS n, count(g.at) AS gone, max(g.at) AS since,
    array_to_string(array_agg('#' || k.blocker ORDER BY k.blocker), ', ') AS waits_on
  FROM mc.work_item_blockers k
  LEFT JOIN LATERAL (
    SELECT max(x.at) AS at FROM (
      SELECT coalesce(p.merged_at, p.closed_at, p.updated_at) AS at
      FROM mc.pull_requests p
      WHERE p.factory = i.factory AND p.number = k.blocker AND p.state = 'closed'
      UNION ALL
      SELECT coalesce(di.closed_at, di.updated_at)
      FROM mc.issues di
      WHERE di.factory = i.factory AND di.number = k.blocker AND di.state = 'closed'
    ) x
  ) g ON true
  WHERE k.project_key = w.project_key AND k.number = w.number
) b
-- The Board's parked rule (`parked` in app/lib/board.ts), as health-workable.sql restates it.
-- db/queries/restated-rules.test.ts fails when they disagree.
WHERE i.factory = $1 AND i.state = 'open' AND b.n > 0 AND b.gone = b.n AND (
  w.build_status = 'parked' AND NOT coalesce(w.triage_at > w.build_at, false)
  OR w.build_status IS DISTINCT FROM 'parked' AND w.merge_status = 'parked'
    AND NOT coalesce(w.triage_at > w.merge_at, false)
    AND (w.build_status IS NULL AND w.own_pr_at IS NOT NULL
      OR NOT coalesce(CASE WHEN w.build_status = 'ready' THEN w.build_at ELSE w.own_pr_at END > w.merge_at, false))
)
UNION ALL
-- Capacity: an answered run Archon could not continue for want of a slot (migration 0031).
SELECT 'capacity', c.item_number, c.run_id, c.workflow_name, 'a free slot', c.since, 'resume',
  f.repository, f.console
FROM mc.capacity_waits c
JOIN mc.factories f ON f.name = c.factory
WHERE c.factory = $1
UNION ALL
-- Claim: a work item claimed by a run in a status the pack's queues release (`claimDisposition`).
SELECT 'claim', w.number, l.run_id, l.workflow_name, 'a claim held by a finished run', l.completed_at,
  'release_claim', f.repository, f.console
FROM mc.work_item_states w
JOIN mc.factories f ON f.codebase = w.project_key AND f.name = $1
JOIN mc.laps l ON l.run_id = w.claim_run_id AND l.status IN ('completed', 'failed', 'cancelled')
