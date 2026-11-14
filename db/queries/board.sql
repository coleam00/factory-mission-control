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
),
-- Each of the factory's loop and queue runs that reached the ship step, once, with the item it holds:
-- its claim, else the facts step's item, else its number input (runs.sql, home-map.sql, health-workable.sql).
claim AS (
  SELECT DISTINCT ON (c.run_id) c.run_id, c.issue_number FROM mc.claims c
  WHERE c.factory = $1
  ORDER BY c.run_id, c.claimed_at DESC NULLS LAST, c.issue_number
),
rounds AS (
  SELECT coalesce(c.issue_number, (f.output -> 'item' ->> 'number')::int, l.issue_number) AS number,
    count(*)::int AS rounds
  FROM mc.laps l
  LEFT JOIN claim c ON c.run_id = l.run_id
  LEFT JOIN mc.lap_steps f ON f.run_id = l.run_id AND f.step_id = 'facts'
  WHERE l.factory = $1 AND l.workflow_name IN ('archon-loop', 'archon-build-queue')
    AND EXISTS (
      SELECT 1 FROM mc.lap_steps s
      WHERE s.run_id = l.run_id AND (s.step_id = 'ship' OR starts_with(s.step_id, 'ship__')))
  GROUP BY 1
),
-- Each pull request's latest app check verdict, once.
checks AS (
  SELECT DISTINCT ON (s.pr_number) s.pr_number, s.output ->> 'overall' AS overall, s.output ->> 'head' AS head
  FROM mc.lap_steps s
  JOIN mc.laps l ON l.run_id = s.run_id
  WHERE l.factory = $1 AND s.step_id IN ('check-app', 'check')
    AND (s.step_id = 'check-app' OR l.workflow_name = 'factory-app-check')
    AND s.pr_number IS NOT NULL
  ORDER BY s.pr_number, s.started_at DESC NULLS LAST, s.run_id
)
SELECT 'item' AS kind, i.number, i.title, i.url, i.state, i.closed_at,
  -- Every work order it carries, by name, as work-orders.sql counts an issue in each of them.
  wo.names AS work_orders,
  -- The route: the queue's state label (intake writes one, and a ready item's names its route),
  -- else the route the loop's latest claim took (the pick step's, else the claim's own).
  coalesce(rt.route, lp.route) AS route,
  -- Archon's finished rounds when the item has a work/<n> state, else the runs that reached ship.
  coalesce(jsonb_array_length(st.rounds), rd.rounds, 0) AS rounds,
  ac.overall AS app_check,
  pr.number AS pr, linked.open AS pr_open,
  st.build_status, st.build_at, st.merge_status, st.merge_at, st.triage_at, st.stage,
  st.rounds::text AS round_list, st.returns, st.last_decision,
  pr.head_sha AS pr_head, ac.head AS app_check_head,
  CASE WHEN st.merge_status = 'merged' AND st.merge_at >= coalesce(st.build_at, '') AND st.merge_at >= coalesce(st.triage_at, '') THEN st.merge_at ELSE CASE WHEN landed.at IS NULL THEN NULL ELSE lpad(extract(year FROM (landed.at AT TIME ZONE 'UTC'))::int::text, 4, '0') || '-' || lpad(extract(month FROM (landed.at AT TIME ZONE 'UTC'))::int::text, 2, '0') || '-' || lpad(extract(day FROM (landed.at AT TIME ZONE 'UTC'))::int::text, 2, '0') || 'T' || date_trunc('second', (landed.at AT TIME ZONE 'UTC'))::time::text || '.' || lpad((floor(extract(milliseconds FROM (landed.at AT TIME ZONE 'UTC')))::bigint % 1000)::text, 3, '0') || 'Z' END END AS merged_at,
  ar.run_id AS app_check_run,
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
LEFT JOIN rounds rd ON rd.number = i.number
LEFT JOIN LATERAL (
  -- The queues' own state for the item (Archon's work/<n> document), as the Board's parked rule reads it.
  SELECT w.build_status, w.build_at, w.merge_status, w.merge_at, w.triage_at, w.stage,
    w.rounds, w.returns, w.last_decision, w.pr_number
  FROM mc.work_item_states w
  JOIN mc.factories f ON f.codebase = w.project_key
  WHERE f.name = i.factory AND w.number = i.number
) st ON true
LEFT JOIN LATERAL (
  -- The open pull request that closes the item (the lowest), else the merged one (the highest).
  SELECT p.number, p.state = 'open' AS open, p.head_sha, p.merged_at
  FROM mc.pull_request_issues pi
  JOIN mc.pull_requests p ON p.factory = pi.factory AND p.number = pi.pr_number
  WHERE pi.factory = i.factory AND pi.issue_number = i.number
    AND (p.state = 'open' OR p.merged_at IS NOT NULL)
  ORDER BY (p.state = 'open') DESC, CASE WHEN p.state = 'open' THEN -p.number ELSE p.number END DESC
  LIMIT 1
) linked ON true
LEFT JOIN LATERAL (
  -- The pull request Archon's last round opened, as a Refs-only pull request has no Closes link.
  SELECT p.number, p.state = 'open' AS open, p.head_sha, p.merged_at
  FROM mc.pull_requests p
  WHERE p.factory = i.factory AND p.number = st.pr_number
    AND (p.state = 'open' OR p.merged_at IS NOT NULL)
) projected ON true
LEFT JOIN LATERAL (
  -- One pull request, so number, head and merged time never describe different ones: the open linked
  -- pull request, else the projected one, else the linked one that landed. A plain select with no set
  -- operation, as Realtime refuses one whose operands read the outer row.
  SELECT
    CASE WHEN linked.open THEN linked.number WHEN projected.number IS NOT NULL THEN projected.number ELSE linked.number END AS number,
    CASE WHEN linked.open THEN linked.head_sha WHEN projected.number IS NOT NULL THEN projected.head_sha ELSE linked.head_sha END AS head_sha,
    CASE WHEN linked.open THEN linked.merged_at WHEN projected.number IS NOT NULL THEN projected.merged_at ELSE linked.merged_at END AS merged_at
) pr ON true
LEFT JOIN LATERAL (
  -- When the item landed, else: the pull request above if it merged, else the latest merged pull request that names
  -- the item with `Refs` (an older item has no Closes link and no pr_number), not for an item closed as not planned or a duplicate.
  SELECT coalesce(pr.merged_at, (
    SELECT max(rm.merged_at) FROM mc.pull_request_references rf
    JOIN mc.pull_requests rm ON rm.factory = rf.factory AND rm.number = rf.pr_number
    WHERE rf.factory = i.factory AND rf.issue_number = i.number AND rm.merged_at IS NOT NULL
      AND coalesce(i.close_reason, 'completed') NOT IN ('not_planned', 'duplicate'))) AS at
) landed ON true
LEFT JOIN checks ac ON ac.pr_number = pr.number
LEFT JOIN LATERAL (
  -- The running app check on the item's pull request: the map's lap rows carry no issue number for them.
  SELECT l.run_id
  FROM mc.laps l
  JOIN mc.lap_steps sel ON sel.run_id = l.run_id AND sel.step_id = 'select'
  WHERE l.factory = i.factory AND l.workflow_name = 'factory-app-check' AND l.status = 'running'
    AND sel.pr_number = pr.number
  ORDER BY l.started_at DESC NULLS LAST, l.run_id LIMIT 1
) ar ON true
UNION ALL
-- One row for the factory: where "N older" points, and how many work items a merged pull
-- request closed or named with `Refs` in all, of which only the newest 200 are above.
SELECT 'factory', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
  NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
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
