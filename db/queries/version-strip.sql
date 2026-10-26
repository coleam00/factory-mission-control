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
-- Pins are shared by every factory (PRD 11.2). One no lap has run is listed only on a factory
-- with a lap, so a factory with no laps shows its empty state.
WHERE EXISTS (SELECT 1 FROM mc.laps l WHERE l.factory = $1)
AND NOT EXISTS (
  SELECT 1 FROM mc.laps l
  WHERE l.factory = $1 AND l.digest IS NOT NULL AND l.started_at > p.committed_at
)
