WITH current AS (
  -- The version the step screen shows without one in its address (step-detail.sql).
  SELECT p.sha
  FROM mc.arch_versions a
  JOIN mc.pins p ON p.archon_sha = a.archon_sha
  JOIN mc.factories f ON f.name = $1
  ORDER BY p.committed_at DESC, a.parsed_at DESC
  LIMIT 1
)
-- Every pin with architecture: the versions the step screen can open. Pins are shared by every
-- factory (PRD 11.2).
SELECT p.sha, p.reason, p.committed_at, p.sha = c.sha AS is_current
FROM mc.pins p
JOIN mc.factories f ON f.name = $1
CROSS JOIN current c
WHERE EXISTS (SELECT 1 FROM mc.arch_versions a WHERE a.archon_sha = p.archon_sha)
