WITH runs AS (
  SELECT s.run_id, s.workflow_name, s.step_id, s.class, s.signature, s.line, s.status, s.stopped_at,
    (s.stopped_at AT TIME ZONE 'UTC')::date AS stopped_day,
    item.issue, CASE WHEN item.issue IS NULL THEN pr.number END AS pr
  FROM mc.run_stops s
  LEFT JOIN mc.laps l ON l.run_id = s.run_id
  LEFT JOIN LATERAL (
    SELECT c.issue_number FROM mc.claims c
    WHERE c.factory = l.factory AND c.run_id = l.run_id
    ORDER BY c.claimed_at DESC NULLS LAST, c.issue_number LIMIT 1
  ) c ON true
  LEFT JOIN mc.lap_steps facts ON facts.run_id = l.run_id AND facts.step_id = 'facts'
  CROSS JOIN LATERAL (
    SELECT coalesce(c.issue_number, (facts.output -> 'item' ->> 'number')::int, l.issue_number) AS issue
  ) item
  CROSS JOIN LATERAL (SELECT min(ps.pr_number) AS number FROM mc.lap_steps ps WHERE ps.run_id = s.run_id) pr
  WHERE s.factory = $1
), last AS (SELECT max(r.stopped_day) AS day FROM runs r),
f AS (
  SELECT r.run_id, r.workflow_name, r.step_id, r.class, r.signature, r.line, r.stopped_at, r.stopped_day
  FROM runs r CROSS JOIN last
  WHERE r.status = 'failed'
    AND NOT coalesce(r.stopped_day <= last.day - 14, false)
    AND NOT EXISTS (
      SELECT 1 FROM runs o
      WHERE o.status = 'completed' AND o.workflow_name = r.workflow_name
        AND (o.issue = r.issue OR o.pr = r.pr) AND o.stopped_at > r.stopped_at
    )
    AND NOT (coalesce(r.class = 'transient', false) AND EXISTS (
      SELECT 1 FROM runs o
      WHERE o.status = 'completed' AND o.workflow_name = r.workflow_name AND o.stopped_at > r.stopped_at
    ))
)
SELECT g.signature, g.workflow_name, g.step_id,
  CASE WHEN g.classes > 1 THEN 'mixed' ELSE latest.class END AS class, g.failures, g.first_at, g.last_at,
  latest.run_id AS latest_run_id, latest.line, last.day AS last_day, d.daily,
  (SELECT console FROM mc.factories WHERE name = $1) AS console
FROM (
  SELECT f.signature, min(f.workflow_name) AS workflow_name, min(f.step_id) AS step_id,
    count(DISTINCT coalesce(f.class, ''))::int AS classes, count(*)::int AS failures, min(f.stopped_at) AS first_at,
    max(f.stopped_at) AS last_at
  FROM f GROUP BY f.signature
) g
CROSS JOIN last
CROSS JOIN LATERAL (
  SELECT f.run_id, f.line, f.class FROM f WHERE f.signature = g.signature
  ORDER BY f.stopped_at DESC NULLS LAST, f.run_id DESC LIMIT 1
) latest
CROSS JOIN LATERAL (
  SELECT array_agg(c.n ORDER BY k.k DESC) AS daily
  FROM (VALUES (0), (1), (2), (3), (4), (5), (6), (7), (8), (9), (10), (11), (12), (13)) AS k(k)
  CROSS JOIN LATERAL (
    SELECT count(*)::int AS n FROM f WHERE f.signature = g.signature AND f.stopped_day = last.day - k.k
  ) c
) d
