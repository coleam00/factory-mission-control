SELECT
  substring(wo.label FROM 12) AS name,
  (count(*))::int AS total_count,
  (count(*) FILTER (WHERE i.state = 'open'))::int AS open_count,
  (count(*) FILTER (WHERE i.state = 'closed' AND coalesce(i.close_reason, 'completed') NOT IN ('not_planned', 'duplicate') AND (mp.n > 0 OR mr.n > 0)))::int AS merged_count,
  min(lo.name) AS lands_on,
  max(i.closed_at) AS last_closed_at
FROM mc.issue_labels wo
JOIN mc.issues i ON i.factory = wo.factory AND i.number = wo.issue_number
LEFT JOIN LATERAL (
  SELECT count(*) AS n
  FROM mc.pull_request_issues pi
  JOIN mc.pull_requests p ON p.factory = pi.factory AND p.number = pi.pr_number
  WHERE pi.factory = i.factory AND pi.issue_number = i.number AND p.merged_at IS NOT NULL
) mp ON true
LEFT JOIN LATERAL (
  SELECT count(*) AS n
  FROM mc.pull_request_references rf
  JOIN mc.pull_requests p ON p.factory = rf.factory AND p.number = rf.pr_number
  WHERE rf.factory = i.factory AND rf.issue_number = i.number AND p.merged_at IS NOT NULL
) mr ON true
LEFT JOIN LATERAL (
  SELECT min(substring(l.label FROM 10)) AS name
  FROM mc.issue_labels l
  JOIN mc.issue_labels wl ON wl.factory = l.factory AND wl.issue_number = l.issue_number
  WHERE l.factory = $1 AND l.label LIKE 'lands-on:%' AND length(l.label) > 9
    AND wl.label = wo.label
) lo ON true
WHERE wo.factory = $1 AND wo.label LIKE 'work-order:%' AND length(wo.label) > 11
  AND i.title NOT IN ('Owner decisions needed', 'Loop metrics')
-- One row per work order: the distinct `work-order:<name>` labels on this factory's issues, but
-- the manager's two tracking issues, which board.sql leaves off the board too.
-- total_count is the order's issues, merged_count those closed, but not as not planned or a duplicate,
-- that a merged pull request closes or names with `Refs`, and
-- lands_on the `lands-on:<target>` label its issues carry, the first by name when they differ.
-- Realtime refuses a subquery inside an expression (db/queries/REALTIME.md), so each count is a
-- LEFT JOIN LATERAL aggregate. last_closed_at is when its latest issue closed, which is when a finished order drops off.
GROUP BY wo.label
ORDER BY wo.label
