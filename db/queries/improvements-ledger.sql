SELECT p.sha AS pin_sha, p.reason, p.measure, p.committed_at, n.laps,
  v.verdict, v.sentence, v.committed_at AS verdict_at, 1 AS pin_matches
FROM mc.pins p
CROSS JOIN LATERAL (
  SELECT count(*)::int AS laps
  FROM mc.laps l JOIN mc.versions b ON b.factory = l.factory AND b.digest = l.digest
  -- The pin is the one mc.versions gives the lap's digest, so the ledger and the version strip agree.
  WHERE l.factory = $1 AND b.pin_sha = p.sha
    AND (l.workflow_name = 'archon-loop' OR l.workflow_name = 'archon-build-queue' AND EXISTS (
    SELECT 1 FROM mc.lap_steps f WHERE f.run_id = l.run_id AND f.step_id = 'facts'
      AND f.output -> 'item' ->> 'number' IS NOT NULL))
) n
-- A verdict names its pin like a decision's `Version:` does, and counts only for the one pin its
-- prefix matches. A prefix of several pins, or of none, is listed below by itself.
LEFT JOIN LATERAL (
  SELECT verdict, sentence, committed_at FROM mc.verdicts
  WHERE pin <> '' AND (starts_with(p.sha, pin) OR starts_with(p.archon_sha, pin))
    AND NOT EXISTS (
      SELECT 1 FROM mc.pins q
      WHERE q.sha <> p.sha AND (starts_with(q.sha, pin) OR starts_with(q.archon_sha, pin))
    )
  ORDER BY committed_at DESC LIMIT 1
) v ON true
-- Pins are shared, but their lap counts are this factory's own. A factory with no runs that date a
-- version lists none.
WHERE EXISTS (SELECT 1 FROM mc.laps l WHERE l.factory = $1 AND l.workflow_name IN ('archon-loop', 'archon-build-queue'))
UNION ALL
-- A verdict whose prefix names no pin, or several, is listed by that prefix with how many pins it
-- names, so the ledger says ambiguous or no pin instead of dropping it. The latest per prefix.
SELECT o.pin, NULL, NULL, o.committed_at, 0, o.verdict, o.sentence, o.committed_at, m.matches
FROM mc.verdicts o
CROSS JOIN LATERAL (
  SELECT count(*)::int AS matches FROM mc.pins q
  WHERE starts_with(q.sha, o.pin) OR starts_with(q.archon_sha, o.pin)
) m
WHERE o.pin <> '' AND m.matches <> 1
  AND NOT EXISTS (
    SELECT 1 FROM mc.verdicts later
    WHERE later.pin = o.pin
      AND (later.committed_at > o.committed_at OR later.committed_at = o.committed_at AND later.sha > o.sha)
  )
  AND EXISTS (SELECT 1 FROM mc.laps l WHERE l.factory = $1 AND l.workflow_name IN ('archon-loop', 'archon-build-queue'))
