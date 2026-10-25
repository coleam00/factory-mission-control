WITH firsts AS (
  SELECT DISTINCT ON (l.digest) l.digest, l.started_at AS first_run_at
  FROM mc.laps l
  WHERE l.factory = $1 AND l.digest IS NOT NULL AND l.started_at IS NOT NULL
  ORDER BY l.digest, l.started_at
)
SELECT f.digest, f.first_run_at, p.sha AS pin_sha, p.reason, p.hypothesis, p.measure, p.committed_at
FROM firsts f
LEFT JOIN LATERAL (
  SELECT sha, reason, hypothesis, measure, committed_at FROM mc.pins
  WHERE committed_at < f.first_run_at ORDER BY committed_at DESC LIMIT 1
) p ON true
UNION ALL
SELECT NULL, NULL, p.sha, p.reason, p.hypothesis, p.measure, p.committed_at
FROM mc.pins p
WHERE NOT EXISTS (
  SELECT 1 FROM mc.laps l
  WHERE l.factory = $1 AND l.digest IS NOT NULL AND l.started_at > p.committed_at
)
