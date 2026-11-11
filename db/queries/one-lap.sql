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
  CASE WHEN prs.merged_at IS NOT NULL THEN 'merged' ELSE prs.state END AS pr_state
FROM mc.laps l
JOIN mc.factories f ON f.name = l.factory
LEFT JOIN LATERAL (
  SELECT c.issue_number, c.route FROM mc.claims c
  WHERE c.factory = l.factory AND c.run_id = l.run_id
  ORDER BY c.claimed_at DESC NULLS LAST, c.issue_number LIMIT 1
) c ON true
LEFT JOIN mc.lap_steps facts ON facts.run_id = l.run_id AND facts.step_id = 'facts'
LEFT JOIN mc.issues i ON i.factory = l.factory AND i.number = coalesce(c.issue_number, (facts.output -> 'item' ->> 'number')::int, l.issue_number)
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
-- A run id compared as text: a malformed one in the address is no run, not a failed query.
WHERE l.factory = $1 AND l.run_id::text = $2
