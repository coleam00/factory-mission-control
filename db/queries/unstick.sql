SELECT 'blocked'::text AS kind, i.number, NULL::uuid AS run_id, NULL::text AS workflow_name,
  b.waits_on, b.since, 'retriage'::text AS action,
  i.title, b.blocker_titles, NULL::text AS reason, f.console
-- Work that stopped moving, with what it waits on, since when, and the one action that moves it.
-- `since` is when it became movable, not when it was first stuck. Four kinds, each keyed by $1.
-- Blocked: an open issue the queues stopped (stage 'blocked') whose every `Depends on` is closed or merged.
FROM mc.issues i
JOIN mc.factories f ON f.name = i.factory
JOIN mc.work_item_states w ON w.project_key = f.codebase AND w.number = i.number AND w.stage = 'blocked'
CROSS JOIN LATERAL (
  SELECT count(*) AS n, count(g.at) AS gone, max(g.at) AS since,
    array_to_string(array_agg('#' || d.depends_on ORDER BY d.depends_on), ', ') AS waits_on,
    array_agg(coalesce(g.title, '') ORDER BY d.depends_on) AS blocker_titles
  FROM mc.issue_dependencies d
  -- Gone: closed or merged. A number that is not mirrored is not known to be gone.
  LEFT JOIN LATERAL (
    SELECT max(x.at) AS at, min(x.title) AS title FROM (
      SELECT coalesce(p.merged_at, p.closed_at, p.updated_at) AS at, p.title
      FROM mc.pull_requests p
      WHERE p.factory = d.factory AND p.number = d.depends_on AND p.state = 'closed'
      UNION ALL
      SELECT coalesce(di.closed_at, di.updated_at), di.title
      FROM mc.issues di
      WHERE di.factory = d.factory AND di.number = d.depends_on AND di.state = 'closed'
    ) x
  ) g ON true
  WHERE d.factory = i.factory AND d.issue_number = i.number
) b
WHERE i.factory = $1 AND i.state = 'open' AND b.n > 0 AND b.gone = b.n
UNION ALL
-- Parked: an open issue parked as the Board reads it whose ruling names only items that are closed or merged.
SELECT 'parked', i.number, NULL, NULL, b.waits_on, b.since, 'retriage',
  i.title, b.blocker_titles, w.parked_reason, f.console
FROM mc.issues i
JOIN mc.factories f ON f.name = i.factory
JOIN mc.work_item_states w ON w.project_key = f.codebase AND w.number = i.number
CROSS JOIN LATERAL (
  SELECT count(*) AS n, count(g.at) AS gone, max(g.at) AS since,
    array_to_string(array_agg('#' || k.blocker ORDER BY k.blocker), ', ') AS waits_on,
    array_agg(coalesce(g.title, '') ORDER BY k.blocker) AS blocker_titles
  FROM mc.work_item_blockers k
  LEFT JOIN LATERAL (
    SELECT max(x.at) AS at, min(x.title) AS title FROM (
      SELECT coalesce(p.merged_at, p.closed_at, p.updated_at) AS at, p.title
      FROM mc.pull_requests p
      WHERE p.factory = i.factory AND p.number = k.blocker AND p.state = 'closed'
      UNION ALL
      SELECT coalesce(di.closed_at, di.updated_at), di.title
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
    AND NOT coalesce(w.build_status = 'ready' AND w.build_at > w.merge_at, false)
)
UNION ALL
-- Capacity: an answered run Archon could not continue for want of a slot (migration 0031).
SELECT 'capacity', c.item_number, c.run_id, c.workflow_name, 'a free slot', c.since, 'resume',
  ci.title, NULL::text[], NULL, f.console
FROM mc.capacity_waits c
JOIN mc.factories f ON f.name = c.factory
LEFT JOIN mc.issues ci ON ci.factory = c.factory AND ci.number = c.item_number
WHERE c.factory = $1
UNION ALL
-- Claim: a work item claimed by a run whose engine lease ended: the run completed or was cancelled
-- or abandoned. A failed run keeps its claim, since it can resume (the pack's README).
SELECT 'claim', w.number, l.run_id, l.workflow_name, 'a claim held by a finished run', l.completed_at,
  'retriage', wi.title, NULL, NULL, f.console
FROM mc.work_item_states w
JOIN mc.factories f ON f.codebase = w.project_key AND f.name = $1
LEFT JOIN mc.issues wi ON wi.factory = f.name AND wi.number = w.number
JOIN mc.laps l ON l.run_id = w.claim_run_id AND l.status IN ('completed', 'cancelled')
