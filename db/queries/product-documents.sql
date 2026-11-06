SELECT d.number, d.title, d.url,
  (coalesce(jsonb_array_length(split.output -> 'issues'), 0)
    + coalesce(jsonb_array_length(split.output -> 'adopted'), 0))::int AS total_count,
  (SELECT count(*) FROM mc.issues i
    WHERE i.factory = d.factory AND i.state = 'closed'
      AND coalesce(i.close_reason, 'completed') NOT IN ('not_planned', 'duplicate')
      AND (split.output -> 'issues' @> ('[{"number": ' || i.number::text || '}]')::jsonb
        OR split.output -> 'adopted' @> ('[{"number": ' || i.number::text || '}]')::jsonb)
      AND (EXISTS (
        SELECT 1 FROM mc.pull_request_issues pi
        JOIN mc.pull_requests p ON p.factory = pi.factory AND p.number = pi.pr_number
        WHERE pi.factory = i.factory AND pi.issue_number = i.number AND p.merged_at IS NOT NULL
      ) OR EXISTS (
        SELECT 1 FROM mc.pull_request_references rf
        JOIN mc.pull_requests p ON p.factory = rf.factory AND p.number = rf.pr_number
        WHERE rf.factory = i.factory AND rf.issue_number = i.number AND p.merged_at IS NOT NULL
      )))::int
    AS merged_count
FROM mc.issues d
JOIN mc.issue_labels prd ON prd.factory = d.factory AND prd.issue_number = d.number
  AND prd.label = 'archon-prd'
LEFT JOIN LATERAL (
  SELECT s.output FROM mc.laps l
  JOIN mc.lap_steps s ON s.run_id = l.run_id AND s.step_id = 'publish'
  WHERE l.factory = d.factory AND l.workflow_name = 'archon-split' AND s.status = 'completed'
    AND s.output ->> 'path' = 'slice' AND (s.output ->> 'item')::integer = d.number
  ORDER BY s.completed_at DESC NULLS LAST, l.run_id DESC
  LIMIT 1
) split ON true
WHERE d.factory = $1 AND d.state = 'open'
ORDER BY d.number
-- One row per open product document: an open issue labelled `archon-prd`. Its work items are the
-- filed and adopted issues in the record of the newest completed `archon-split` `publish` step for
-- that issue, from the output `mc.lap_steps` keeps whole. A document with no such record counts
-- 0 of 0. Merged is the Board's rule: closed, not as not planned or a duplicate, with a merged pull request that
-- closes it or names it with Refs. The `@>` literal is
-- built with `||` and `::jsonb` because `jsonb_build_object` is stable and Realtime refuses it.
