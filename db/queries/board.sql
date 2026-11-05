WITH items AS (
  -- The board's work items (PRD 4.1): the open issues, but the manager's two tracking issues, and
  -- the newest 200 closed, but not as not planned or a duplicate, that a merged pull request closed or
  -- named with `Refs`. Which column each sits in is the
  -- browser's, from the map's own rules.
  SELECT i.* FROM mc.issues i
  WHERE i.factory = $1 AND i.state = 'open'
    AND i.title NOT IN ('Owner decisions needed', 'Loop metrics')
  UNION ALL
  SELECT * FROM (
    SELECT i.* FROM mc.issues i
    WHERE i.factory = $1 AND i.state = 'closed' AND coalesce(i.close_reason, 'completed') NOT IN ('not_planned', 'duplicate') AND (EXISTS (
      SELECT 1 FROM mc.pull_request_issues pi
      JOIN mc.pull_requests p ON p.factory = pi.factory AND p.number = pi.pr_number
      WHERE pi.factory = i.factory AND pi.issue_number = i.number AND p.merged_at IS NOT NULL
    ) OR EXISTS (
      SELECT 1 FROM mc.pull_request_references rf
      JOIN mc.pull_requests p ON p.factory = rf.factory AND p.number = rf.pr_number
      WHERE rf.factory = i.factory AND rf.issue_number = i.number AND p.merged_at IS NOT NULL
    ))
    ORDER BY i.closed_at DESC NULLS LAST, i.number DESC
    LIMIT 200
  ) closed
)
SELECT 'item' AS kind, i.number, i.title, i.url, i.state, i.closed_at,
  -- Every work order it carries, by name, as work-orders.sql counts an issue in each of them.
  wo.names AS work_orders,
  -- The route: the queue's state label (intake writes one, and a ready item's names its route),
  -- else the route the loop's latest claim took (the pick step's, else the claim's own).
  coalesce(rt.route, lp.route) AS route,
  coalesce(rd.rounds, 0) AS rounds,
  ac.overall AS app_check,
  pr.number AS pr, pr.open AS pr_open,
  NULL::text AS repository, NULL::integer AS merged_total
FROM items i
LEFT JOIN LATERAL (
  SELECT coalesce(array_agg(substring(lb.label FROM 12) ORDER BY lb.label), '{}'::text[]) AS names FROM mc.issue_labels lb
  WHERE lb.factory = i.factory AND lb.issue_number = i.number
    AND lb.label LIKE 'work-order:%' AND length(lb.label) > 11
) wo ON true
LEFT JOIN LATERAL (
  SELECT min(CASE lb.label
    WHEN 'archon-ready' THEN 'deliver' WHEN 'archon-plan' THEN 'plan'
    WHEN 'archon-investigate' THEN 'investigate' WHEN 'archon-split' THEN 'split' END) AS route
  FROM mc.issue_labels lb
  WHERE lb.factory = i.factory AND lb.issue_number = i.number
) rt ON true
LEFT JOIN LATERAL (
  SELECT coalesce(pick.output ->> 'route', c.route) AS route
  FROM mc.claims c
  LEFT JOIN mc.lap_steps pick ON pick.run_id = c.run_id AND pick.step_id = 'pick'
  WHERE c.factory = i.factory AND c.issue_number = i.number
  ORDER BY c.claimed_at DESC NULLS LAST, c.run_id LIMIT 1
) lp ON true
LEFT JOIN LATERAL (
  -- Rounds so far: the item's runs that reached the ship step, by claim or by number input.
  SELECT count(*)::int AS rounds FROM mc.laps l
  WHERE l.factory = i.factory AND l.workflow_name IN ('archon-loop', 'archon-build-queue')
    AND (l.issue_number = i.number OR EXISTS (
      SELECT 1 FROM mc.claims c
      WHERE c.factory = l.factory AND c.run_id = l.run_id AND c.issue_number = i.number))
    AND EXISTS (
      SELECT 1 FROM mc.lap_steps s
      WHERE s.run_id = l.run_id AND (s.step_id = 'ship' OR starts_with(s.step_id, 'ship__')))
) rd ON true
LEFT JOIN LATERAL (
  -- The open pull request that closes the item (the lowest), else the merged one (the highest).
  SELECT p.number, p.state = 'open' AS open
  FROM mc.pull_request_issues pi
  JOIN mc.pull_requests p ON p.factory = pi.factory AND p.number = pi.pr_number
  WHERE pi.factory = i.factory AND pi.issue_number = i.number
    AND (p.state = 'open' OR p.merged_at IS NOT NULL)
  ORDER BY (p.state = 'open') DESC, CASE WHEN p.state = 'open' THEN -p.number ELSE p.number END DESC
  LIMIT 1
) pr ON true
LEFT JOIN LATERAL (
  -- That pull request's latest app check verdict, as the map's failing chip reads it.
  SELECT s.output ->> 'overall' AS overall
  FROM mc.lap_steps s
  JOIN mc.laps l ON l.run_id = s.run_id
  WHERE l.factory = i.factory AND s.step_id IN ('check-app', 'check') AND pr.number IS NOT NULL
    AND (s.step_id = 'check-app' OR l.workflow_name = 'factory-app-check')
    AND substring(s.output ->> 'pr' FROM '([0-9]+)/?$')::integer = pr.number
  ORDER BY s.started_at DESC NULLS LAST, s.run_id LIMIT 1
) ac ON true
UNION ALL
-- One row for the factory: where "N older" points, and how many work items a merged pull
-- request closed or named with `Refs` in all, of which only the newest 200 are above.
SELECT 'factory', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
  f.repository,
  (SELECT count(*)::int FROM mc.issues i
   WHERE i.factory = f.name AND i.state = 'closed' AND coalesce(i.close_reason, 'completed') NOT IN ('not_planned', 'duplicate') AND (EXISTS (
     SELECT 1 FROM mc.pull_request_issues pi
     JOIN mc.pull_requests p ON p.factory = pi.factory AND p.number = pi.pr_number
     WHERE pi.factory = i.factory AND pi.issue_number = i.number AND p.merged_at IS NOT NULL
   ) OR EXISTS (
     SELECT 1 FROM mc.pull_request_references rf
     JOIN mc.pull_requests p ON p.factory = rf.factory AND p.number = rf.pr_number
     WHERE rf.factory = i.factory AND rf.issue_number = i.number AND p.merged_at IS NOT NULL
   )))
FROM mc.factories f
WHERE f.name = $1
