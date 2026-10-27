SELECT l.run_id, l.status, l.started_at, l.completed_at, f.repository, f.console,
  c.issue_number, i.title AS issue_title, i.url AS issue_url,
  -- The pick step's route, or else the one the lap's claim comment records, as lanes.sql reads it.
  coalesce(p.output ->> 'route', c.route) AS route, p.output ->> 'depth' AS depth,
  pr.pr,
  -- The review's outcome and dispositions (PRD 4.6), and the gate's: a refusal is the land step's
  -- output with outcome refused, its reason the reason text (PRD 4.2).
  review.status AS review_status, review.output ->> 'outcome' AS review_outcome,
  review.output ->> 'delivers' AS review_delivers, review.output -> 'dispositions' AS dispositions,
  land.status AS gate_status, land.output ->> 'outcome' AS gate_outcome,
  land.output ->> 'reason' AS gate_reason
FROM mc.laps l
JOIN mc.factories f ON f.name = l.factory
LEFT JOIN LATERAL (
  SELECT c.issue_number, c.route FROM mc.claims c
  WHERE c.factory = l.factory AND c.run_id = l.run_id
  ORDER BY c.claimed_at DESC NULLS LAST, c.issue_number LIMIT 1
) c ON true
LEFT JOIN mc.issues i ON i.factory = l.factory AND i.number = c.issue_number
LEFT JOIN mc.lap_steps p ON p.run_id = l.run_id AND p.step_id = 'pick'
LEFT JOIN mc.lap_steps review ON review.run_id = l.run_id AND review.step_id = 'review'
LEFT JOIN mc.lap_steps land ON land.run_id = l.run_id AND land.step_id = 'land'
-- The pull request the lap's newest step names: subject, check-app and review each carry it.
LEFT JOIN LATERAL (
  SELECT s.output ->> 'pr' AS pr FROM mc.lap_steps s
  WHERE s.run_id = l.run_id AND s.output ->> 'pr' <> ''
  ORDER BY s.started_at DESC NULLS LAST, s.step_id LIMIT 1
) pr ON true
-- A run id compared as text: a malformed one in the address is no lap, not a failed query.
WHERE l.factory = $1 AND l.run_id::text = $2 AND l.workflow_name = 'archon-loop'
