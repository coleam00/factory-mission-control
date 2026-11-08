WITH f AS (
  SELECT s.run_id, s.workflow_name, s.step_id, s.class, s.signature, s.line, s.stopped_at, s.stopped_day
  FROM mc.run_stops s WHERE s.factory = $1 AND s.status = 'failed'
), last AS (SELECT max(f.stopped_day) AS day FROM f)
SELECT g.signature, g.workflow_name, g.step_id, g.class, g.failures, g.first_at, g.last_at,
  latest.run_id AS latest_run_id, latest.line, last.day AS last_day, d.daily
FROM (
  SELECT f.signature, min(f.workflow_name) AS workflow_name, min(f.step_id) AS step_id,
    min(f.class) AS class, count(*)::int AS failures, min(f.stopped_at) AS first_at,
    max(f.stopped_at) AS last_at
  FROM f GROUP BY f.signature
) g
CROSS JOIN last
CROSS JOIN LATERAL (
  SELECT f.run_id, f.line FROM f WHERE f.signature = g.signature
  ORDER BY f.stopped_at DESC NULLS LAST, f.run_id DESC LIMIT 1
) latest
CROSS JOIN LATERAL (
  SELECT array_agg(c.n ORDER BY k.k DESC) AS daily
  FROM (VALUES (0), (1), (2), (3), (4), (5), (6), (7), (8), (9), (10), (11), (12), (13)) AS k(k)
  CROSS JOIN LATERAL (
    SELECT count(*)::int AS n FROM f WHERE f.signature = g.signature AND f.stopped_day = last.day - k.k
  ) c
) d
