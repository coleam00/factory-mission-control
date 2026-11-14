SELECT u.kind, u.number, u.run_id, u.workflow_name, u.waits_on, u.since, u.action, u.title,
  u.blocker_titles, u.reason, u.console, u.open,
  CASE WHEN NOT (x.action = 'close' AND (NOT u.open OR moved.n > 0)) AND intake.n = 0 THEN x.action END AS sent_action,
  CASE WHEN NOT (x.action = 'close' AND (NOT u.open OR moved.n > 0)) AND intake.n = 0 THEN x.sent_at END AS sent_at
FROM (
SELECT 'blocked'::text AS kind, i.number, NULL::uuid AS run_id, NULL::text AS workflow_name,
  b.waits_on, b.since, 'retriage'::text AS action,
  i.title, b.blocker_titles, NULL::text AS reason, f.console, true AS open
-- Work that stopped moving, with what it waits on, since when, and the one action that moves it.
-- `since` is when it became movable, not when it was first stuck. Four kinds, each keyed by $1.
-- `open` is whether the mirror holds the item open: the item writes are offered only then.
-- `sent_action` and `sent_at` are the item's latest write sent from the dashboard, not undone, exit 0,
-- that the mirror has not caught up with, both null when none.
-- Blocked: an open issue the queues stopped (stage 'blocked') whose every `Depends on` is closed or merged.
FROM mc.issues i
JOIN mc.factories f ON f.name = i.factory
JOIN mc.work_item_states w ON w.project_key = f.codebase AND w.number = i.number AND w.stage = 'blocked'
CROSS JOIN LATERAL (
  SELECT count(*) AS n, count(greatest(gp.at, gi.at)) AS gone, max(greatest(gp.at, gi.at)) AS since,
    array_to_string(array_agg('#' || d.depends_on ORDER BY d.depends_on), ', ') AS waits_on,
    array_agg(coalesce(least(gp.title, gi.title), '') ORDER BY d.depends_on) AS blocker_titles
  FROM mc.issue_dependencies d
  -- Gone: closed or merged. A number that is not mirrored is not known to be gone.
  LEFT JOIN LATERAL (
    SELECT max(coalesce(p.merged_at, p.closed_at, p.updated_at)) AS at, min(p.title) AS title
    FROM mc.pull_requests p
    WHERE p.factory = d.factory AND p.number = d.depends_on AND p.state = 'closed'
  ) gp ON true
  LEFT JOIN LATERAL (
    SELECT max(coalesce(di.closed_at, di.updated_at)) AS at, min(di.title) AS title
    FROM mc.issues di
    WHERE di.factory = d.factory AND di.number = d.depends_on AND di.state = 'closed'
  ) gi ON true
  WHERE d.factory = i.factory AND d.issue_number = i.number
) b
WHERE i.factory = $1 AND i.state = 'open' AND b.n > 0 AND b.gone = b.n
UNION ALL
-- Parked: an open issue parked as the Board reads it whose ruling names only items that are closed or merged.
SELECT 'parked', i.number, NULL, NULL, b.waits_on, b.since, 'retriage',
  i.title, b.blocker_titles, w.parked_reason, f.console, true
FROM mc.issues i
JOIN mc.factories f ON f.name = i.factory
JOIN mc.work_item_states w ON w.project_key = f.codebase AND w.number = i.number
CROSS JOIN LATERAL (
  SELECT count(*) AS n, count(greatest(gp.at, gi.at)) AS gone, max(greatest(gp.at, gi.at)) AS since,
    array_to_string(array_agg('#' || k.blocker ORDER BY k.blocker), ', ') AS waits_on,
    array_agg(coalesce(least(gp.title, gi.title), '') ORDER BY k.blocker) AS blocker_titles
  FROM mc.work_item_blockers k
  LEFT JOIN LATERAL (
    SELECT max(coalesce(p.merged_at, p.closed_at, p.updated_at)) AS at, min(p.title) AS title
    FROM mc.pull_requests p
    WHERE p.factory = i.factory AND p.number = k.blocker AND p.state = 'closed'
  ) gp ON true
  LEFT JOIN LATERAL (
    SELECT max(coalesce(di.closed_at, di.updated_at)) AS at, min(di.title) AS title
    FROM mc.issues di
    WHERE di.factory = i.factory AND di.number = k.blocker AND di.state = 'closed'
  ) gi ON true
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
  ci.title, NULL::text[], NULL, f.console, coalesce(ci.state = 'open', false)
FROM mc.capacity_waits c
JOIN mc.factories f ON f.name = c.factory
LEFT JOIN mc.issues ci ON ci.factory = c.factory AND ci.number = c.item_number
WHERE c.factory = $1
UNION ALL
-- Claim: a work item claimed by a run whose engine lease ended: the run completed or was cancelled
-- or abandoned. A failed run keeps its claim, since it can resume (the pack's README).
SELECT 'claim', w.number, l.run_id, l.workflow_name, 'a claim held by a finished run', l.completed_at,
  'retriage', wi.title, NULL, NULL, f.console, coalesce(wi.state = 'open', false)
FROM mc.work_item_states w
JOIN mc.factories f ON f.codebase = w.project_key AND f.name = $1
LEFT JOIN mc.issues wi ON wi.factory = f.name AND wi.number = w.number
JOIN mc.laps l ON l.run_id = w.claim_run_id AND l.status IN ('completed', 'cancelled')
)  u
-- Sent (the two tests are counted by lateral joins and read in the select list, as a precaution: a
-- subquery in a NOT/OR is not probed in db/queries/REALTIME.md): the item's latest write from the dashboard (retriage, close or comment, never undone or failed
-- ones), until the mirror catches up: an intake run on the item has finished since,
-- or, for a close, the mirror holds the issue closed or has moved it since the CLI returned (a reopened
-- issue is open again, so only its updated_at tells it was closed). The close's own note moves the
-- issue before the CLI returns, so it does not end the close. Rows from before `finished_at` use sent_at.
LEFT JOIN LATERAL (
  SELECT a.action, a.sent_at, coalesce(a.finished_at, a.sent_at) AS finished_at
  FROM mc.actions a
  WHERE a.factory = $1 AND a.item_number = u.number AND NOT a.undone AND a.exit_code = 0
  ORDER BY a.sent_at DESC, a.id DESC
  LIMIT 1
) x ON true
LEFT JOIN LATERAL (
  SELECT count(*) AS n FROM mc.issues ci
  WHERE ci.factory = $1 AND ci.number = u.number AND ci.updated_at > x.finished_at
) moved ON true
LEFT JOIN LATERAL (
  SELECT count(*) AS n FROM mc.laps il
  WHERE il.factory = $1 AND il.issue_number = u.number AND il.workflow_name = 'archon-intake'
    AND il.started_at >= x.sent_at AND il.completed_at IS NOT NULL
) intake ON true
