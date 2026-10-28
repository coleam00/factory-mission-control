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
-- A verdict names its pin like a decision's `Version:` does, and counts only for the one pin its
-- prefix matches. A prefix of several pins is no pin's verdict.
LEFT JOIN LATERAL (
  SELECT verdict, sentence, committed_at FROM mc.verdicts
  WHERE pin <> '' AND (starts_with(p.sha, pin) OR starts_with(p.archon_sha, pin))
    AND NOT EXISTS (
      SELECT 1 FROM mc.pins q
      WHERE q.sha <> p.sha AND (starts_with(q.sha, pin) OR starts_with(q.archon_sha, pin))
    )
  ORDER BY committed_at DESC LIMIT 1
) v ON true
-- Pins are shared, but their lap counts are this factory's own. A factory with no laps lists none.
WHERE EXISTS (SELECT 1 FROM mc.laps l WHERE l.factory = $1 AND l.workflow_name = 'archon-loop')
