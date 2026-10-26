WITH firsts AS (
  SELECT DISTINCT ON (l.digest) l.digest, l.started_at AS first_run_at
  FROM mc.laps l
  WHERE l.factory = $1 AND l.digest IS NOT NULL AND l.started_at IS NOT NULL
  ORDER BY l.digest, l.started_at
),
labelled AS (
  SELECT f.digest, p.sha AS pin_sha
  FROM firsts f
  CROSS JOIN LATERAL (
    SELECT sha FROM mc.pins
    WHERE committed_at < f.first_run_at ORDER BY committed_at DESC LIMIT 1
  ) p
)
SELECT p.sha AS pin_sha, p.reason, p.measure, p.committed_at, n.laps,
  v.verdict, v.sentence, v.committed_at AS verdict_at
FROM mc.pins p
CROSS JOIN LATERAL (
  SELECT count(*)::int AS laps
  FROM mc.laps l JOIN labelled b ON b.digest = l.digest
  WHERE l.factory = $1 AND l.workflow_name = 'archon-loop' AND b.pin_sha = p.sha
) n
LEFT JOIN LATERAL (
  SELECT verdict, sentence, committed_at FROM mc.verdicts
  WHERE pin <> '' AND starts_with(p.sha, pin)
  ORDER BY committed_at DESC LIMIT 1
) v ON true
