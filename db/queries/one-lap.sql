SELECT l.run_id, l.workflow_name, l.status, l.started_at, l.completed_at, f.repository, f.console,
  -- The item the run is on, by runs.sql's rule: its claim, else the item its facts step names, else the lap's.
  coalesce(c.issue_number, (facts.output -> 'item' ->> 'number')::int, l.issue_number) AS issue_number,
  i.title AS issue_title, i.url AS issue_url,
  -- The pick step's route, or else the one the lap's claim comment records.
  coalesce(p.output ->> 'route', c.route) AS route, p.output ->> 'depth' AS depth,
  pr.pr_number,
  -- The review's outcome and dispositions (PRD 4.6), and the gate's: a refusal is the land step's
  -- output with outcome refused, its reason the reason text (PRD 4.2).
  review.status AS review_status, review.output ->> 'outcome' AS review_outcome,
  review.output ->> 'delivers' AS review_delivers, review.output -> 'dispositions' AS dispositions,
  -- The old holdout lines the checks panel never shows: app/lib/one-lap.ts drops the dispositions
  -- that answer them (Realtime refuses a set-returning function to filter the list here).
  ARRAY(SELECT a.line_id FROM mc.app_check_lines a
        WHERE a.run_id = l.run_id AND a.kind = 'holdout' AND a.line_id IS NOT NULL) AS hidden_lines,
  land.status AS gate_status, land.output ->> 'outcome' AS gate_outcome,
  land.output ->> 'reason' AS gate_reason,
  -- Why the run stopped (mc.run_stops, #513): the manager's read is written from it.
  st.status AS stop_status, st.step_id AS stop_step, st.line AS stop_line, st.class AS stop_class,
  -- Set while Archon holds the answered run for a free slot (mc.capacity_waits): it waits on no one.
  cw.since AS capacity_since,
  -- The pull request's state from the GitHub mirror: 'merged' once the mirror records it landed, null when the run names no PR or the mirror lacks it.
  CASE WHEN prs.merged_at IS NOT NULL THEN 'merged' ELSE prs.state END AS pr_state,
  -- Whether a failed run's item is finished, by failure-groups.sql's rule (restated-rules.test.ts holds the two together):
  -- the item (the issue, or with none the run's smallest step PR) is closed, or a later run of the workflow completed on it.
  cl.closed_at AS item_closed_at, cl.merged_at AS item_merged_at,
  CASE WHEN item.issue IS NULL THEN pitem.number END AS item_pr,
  fin.run_id AS finished_by, fin.stopped_at AS finished_at,
  -- The run that finished the item at its close: the latest later run that was running at that moment
  -- (started at or before it, stopped at or after it), since the run that lands the item stops after it lands.
  -- Null when no run spans the close. finished_by is the first to follow the failure, which may have merged nothing.
  fin.closed_by
FROM mc.laps l
JOIN mc.factories f ON f.name = l.factory
LEFT JOIN LATERAL (
  SELECT c.issue_number, c.route FROM mc.claims c
  WHERE c.factory = l.factory AND c.run_id = l.run_id
  ORDER BY c.claimed_at DESC NULLS LAST, c.issue_number LIMIT 1
) c ON true
LEFT JOIN mc.lap_steps facts ON facts.run_id = l.run_id AND facts.step_id = 'facts'
CROSS JOIN LATERAL (
  SELECT coalesce(c.issue_number, (facts.output -> 'item' ->> 'number')::int, l.issue_number) AS issue
) item
CROSS JOIN LATERAL (SELECT min(ps.pr_number) AS number FROM mc.lap_steps ps WHERE ps.run_id = l.run_id) pitem
LEFT JOIN mc.issues i ON i.factory = l.factory AND i.number = item.issue
LEFT JOIN mc.pull_requests pip ON pip.factory = l.factory AND pip.number = pitem.number AND item.issue IS NULL
CROSS JOIN LATERAL (
  SELECT CASE WHEN item.issue IS NOT NULL THEN
      CASE WHEN i.state = 'closed' THEN coalesce(i.closed_at, i.updated_at) END
    ELSE CASE WHEN pip.state = 'closed' THEN coalesce(pip.closed_at, pip.updated_at) END END AS closed_at,
    CASE WHEN item.issue IS NOT NULL THEN
      -- The latest landing among the item's Closes-linked pull requests and its landed Refs-linked ones (board.sql's rule),
      -- greatest() skips a null side, and a set operation here would read the outer row, which Realtime refuses.
      greatest(
        (SELECT max(m.merged_at) FROM mc.pull_request_issues x
         JOIN mc.pull_requests m ON m.factory = x.factory AND m.number = x.pr_number
         WHERE x.factory = l.factory AND x.issue_number = item.issue),
        (SELECT max(rm.merged_at) FROM mc.pull_request_references rf
         JOIN mc.pull_requests rm ON rm.factory = rf.factory AND rm.number = rf.pr_number
         WHERE rf.factory = l.factory AND rf.issue_number = item.issue AND rm.merged_at IS NOT NULL))
    ELSE pip.merged_at END AS merged_at
) cl
LEFT JOIN mc.run_stops st ON st.run_id = l.run_id
LEFT JOIN mc.capacity_waits cw ON cw.run_id = l.run_id
LEFT JOIN mc.lap_steps p ON p.run_id = l.run_id AND p.step_id = 'pick'
LEFT JOIN mc.lap_steps review ON review.run_id = l.run_id AND review.step_id = 'review'
LEFT JOIN mc.lap_steps land ON land.run_id = l.run_id AND land.step_id = 'land'
-- The pull request the run's newest step names (its projected pr_number): subject, check-app and review each carry it.
LEFT JOIN LATERAL (
  SELECT s.pr_number FROM mc.lap_steps s
  WHERE s.run_id = l.run_id AND s.pr_number IS NOT NULL
  ORDER BY s.started_at DESC NULLS LAST, s.step_id LIMIT 1
) pr ON true
LEFT JOIN mc.pull_requests prs ON prs.factory = l.factory AND prs.number = pr.pr_number
LEFT JOIN LATERAL (
  SELECT (array_agg(d.run_id ORDER BY d.stopped_at, d.run_id))[1] AS run_id, min(d.stopped_at) AS stopped_at,
    (array_agg(d.run_id ORDER BY d.stopped_at DESC, d.run_id DESC)
      FILTER (WHERE d.started_at <= coalesce(cl.merged_at, cl.closed_at)
        AND d.stopped_at >= coalesce(cl.merged_at, cl.closed_at)))[1] AS closed_by
  FROM (
    SELECT o.run_id, o.stopped_at, ol.started_at FROM mc.run_stops o
    LEFT JOIN mc.laps ol ON ol.run_id = o.run_id
    LEFT JOIN LATERAL (
      SELECT oc.issue_number FROM mc.claims oc
      WHERE oc.factory = ol.factory AND oc.run_id = ol.run_id
      ORDER BY oc.claimed_at DESC NULLS LAST, oc.issue_number LIMIT 1
    ) oc ON true
    LEFT JOIN mc.lap_steps ofacts ON ofacts.run_id = ol.run_id AND ofacts.step_id = 'facts'
    CROSS JOIN LATERAL (
      SELECT coalesce(oc.issue_number, (ofacts.output -> 'item' ->> 'number')::int, ol.issue_number) AS issue
    ) oitem
    CROSS JOIN LATERAL (SELECT min(ps.pr_number) AS number FROM mc.lap_steps ps WHERE ps.run_id = o.run_id) opr
    WHERE l.status = 'failed' AND o.factory = l.factory AND o.status = 'completed'
      AND o.workflow_name = l.workflow_name AND o.stopped_at > st.stopped_at
      AND ((item.issue IS NULL AND pitem.number IS NULL)
        OR oitem.issue = item.issue OR (item.issue IS NULL AND oitem.issue IS NULL AND opr.number = pitem.number))
  ) d
) fin ON true
-- A run id compared as text: a malformed one in the address is no run, not a failed query.
WHERE l.factory = $1 AND l.run_id::text = $2
