SELECT v.digest, v.first_run_at, v.pin_sha, p.reason, p.hypothesis, p.measure, p.committed_at
FROM mc.versions v
LEFT JOIN mc.pins p ON p.sha = v.pin_sha
WHERE v.factory = $1
UNION ALL
SELECT NULL, NULL, p.sha, p.reason, p.hypothesis, p.measure, p.committed_at
FROM mc.pins p
-- Pins are shared by every factory (PRD 11.2). One that labels none of this factory's versions has
-- not run here, whether older or newer than those that have (#232). It is listed only on a factory
-- with a lap, so a factory with no laps shows its empty state. A lap is an archon-loop run.
WHERE EXISTS (SELECT 1 FROM mc.laps l WHERE l.factory = $1 AND l.workflow_name = 'archon-loop')
AND NOT EXISTS (SELECT 1 FROM mc.versions v WHERE v.factory = $1 AND v.pin_sha = p.sha)
