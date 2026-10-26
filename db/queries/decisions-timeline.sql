WITH firsts AS (
  SELECT DISTINCT ON (l.digest) l.digest, l.started_at AS first_run_at
  FROM mc.laps l
  WHERE l.factory = $1 AND l.digest IS NOT NULL AND l.started_at IS NOT NULL
  ORDER BY l.digest, l.started_at
)
SELECT d.date::text AS date, d.title, d.decision, d.why, d.replaces, d.version, p.sha AS pin_sha, v.digest
FROM mc.decisions d
LEFT JOIN LATERAL (
  SELECT sha, committed_at FROM mc.pins
  WHERE factory = $1 AND d.version <> '' AND starts_with(sha, d.version)
  ORDER BY committed_at DESC LIMIT 1
) p ON true
LEFT JOIN LATERAL (
  SELECT f.digest FROM firsts f
  WHERE f.first_run_at > p.committed_at AND NOT EXISTS (
    SELECT 1 FROM mc.pins q
    WHERE q.factory = $1 AND q.committed_at > p.committed_at AND q.committed_at < f.first_run_at
  )
  ORDER BY f.first_run_at LIMIT 1
) v ON true
