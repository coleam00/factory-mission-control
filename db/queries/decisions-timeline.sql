WITH firsts AS (
  -- A version is a digest this factory's archon-loop laps ran (mc.versions), no other workflow's.
  SELECT DISTINCT ON (l.digest) l.digest, l.started_at AS first_run_at
  FROM mc.laps l
  WHERE l.factory = $1 AND l.workflow_name = 'archon-loop' AND l.digest IS NOT NULL
    AND l.started_at IS NOT NULL
  ORDER BY l.digest, l.started_at
)
SELECT d.date::text AS date, d.title, d.decision, d.why, d.replaces, d.version,
  CASE WHEN p.matches = 1 THEN p.sha END AS pin_sha, coalesce(p.matches > 1, false) AS ambiguous,
  v.digest
FROM mc.decisions d
-- `Version:` names a pin by a prefix of its commit's sha or of the Archon sha it pins (PRD 11.5,
-- #178). It links only when one pin matches. A prefix of several pins is ambiguous, never a guess.
LEFT JOIN LATERAL (
  SELECT sha, committed_at, count(*) OVER () AS matches FROM mc.pins
  WHERE d.version <> '' AND (starts_with(sha, d.version) OR starts_with(archon_sha, d.version))
  ORDER BY committed_at DESC LIMIT 1
) p ON true
LEFT JOIN LATERAL (
  SELECT f.digest FROM firsts f
  WHERE p.matches = 1 AND f.first_run_at > p.committed_at AND NOT EXISTS (
    SELECT 1 FROM mc.pins q
    WHERE q.committed_at > p.committed_at AND q.committed_at < f.first_run_at
  )
  ORDER BY f.first_run_at LIMIT 1
) v ON true
-- Decisions are the shared factory process's (PRD 11.5), listed only on a factory with a lap, so a
-- factory with no laps shows its empty state. A lap is an archon-loop run.
WHERE EXISTS (SELECT 1 FROM mc.laps l WHERE l.factory = $1 AND l.workflow_name = 'archon-loop')
