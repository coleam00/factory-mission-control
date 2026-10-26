SELECT l.run_id, l.status, l.started_at, l.completed_at, c.issue_number,
  -- A finished lap's outcome, by the scorecard's definitions (PRD 4.2): a failed run first, then
  -- the land step's outcome, the review's, and a pick of route none.
  CASE
    WHEN l.status = 'failed' THEN 'failed'
    WHEN land.output ->> 'outcome' = 'merged' THEN 'merged'
    WHEN land.output ->> 'outcome' = 'refused' THEN 'gate-refused'
    WHEN review.output ->> 'outcome' = 'sent-back' THEN 'sent-back'
    WHEN review.output ->> 'outcome' = 'needs-owner' THEN 'needs-owner'
    WHEN pick.output ->> 'route' = 'none' THEN 'nothing'
  END AS outcome,
  k.cost_usd
FROM mc.laps l
LEFT JOIN LATERAL (
  SELECT c.issue_number FROM mc.claims c
  WHERE c.factory = l.factory AND c.run_id = l.run_id
  ORDER BY c.claimed_at DESC NULLS LAST, c.issue_number LIMIT 1
) c ON true
LEFT JOIN mc.lap_steps pick ON pick.run_id = l.run_id AND pick.step_id = 'pick'
LEFT JOIN mc.lap_steps review ON review.run_id = l.run_id AND review.step_id = 'review'
LEFT JOIN mc.lap_steps land ON land.run_id = l.run_id AND land.step_id = 'land'
LEFT JOIN LATERAL (
  SELECT sum(ls.cost_usd)::float8 AS cost_usd FROM mc.lap_steps ls WHERE ls.run_id = l.run_id
) k ON true
WHERE l.factory = $1 AND l.workflow_name = 'archon-loop'
  AND l.status IN ('completed', 'failed', 'cancelled')
