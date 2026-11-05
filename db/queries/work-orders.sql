SELECT
  substring(wo.label FROM 12) AS name,
  (count(*) FILTER (WHERE i.state = 'open'))::int AS open_count,
  (count(*) FILTER (WHERE i.state = 'closed' AND EXISTS (
    SELECT 1 FROM mc.pull_request_issues pi
    JOIN mc.pull_requests p ON p.factory = pi.factory AND p.number = pi.pr_number
    WHERE pi.factory = i.factory AND pi.issue_number = i.number AND p.merged_at IS NOT NULL
  )))::int AS merged_count,
  (SELECT min(substring(lo.label FROM 10))
   FROM mc.issue_labels lo
   JOIN mc.issue_labels wl ON wl.factory = lo.factory AND wl.issue_number = lo.issue_number
   WHERE lo.factory = $1 AND lo.label LIKE 'lands-on:%' AND length(lo.label) > 9
     AND wl.label = wo.label) AS lands_on
FROM mc.issue_labels wo
JOIN mc.issues i ON i.factory = wo.factory AND i.number = wo.issue_number
WHERE wo.factory = $1 AND wo.label LIKE 'work-order:%' AND length(wo.label) > 11
-- One row per work order with an open issue: the distinct `work-order:<name>` labels on this
-- factory's open issues. merged_count is the order's issues a merged pull request closed, and
-- lands_on the `lands-on:<target>` label its issues carry, the first by name when they differ.
GROUP BY wo.label
HAVING count(*) FILTER (WHERE i.state = 'open') > 0
ORDER BY wo.label
