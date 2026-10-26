-- Pins hold the full Archon sha (issue #157). Before this, a pin stored the sha its commit subject
-- named (`Pin Archon ee4e0231: ...`), while every mc.arch_* row is keyed by the full 40-character
-- sha, so the home map, the step screens and the architecture diff, which join on equality, found
-- no architecture for it. The webhook and backfill now store the full sha from the pin commit's
-- template/factory/pack.json; this rewrites the short values already stored.
--
-- A short pin becomes the one parsed Archon sha it prefixes. A prefix that matches several parsed
-- versions, or none, is left as it is for the next backfill, so it keeps reading "No architecture
-- is recorded" and never shows another version's architecture. Run again, it rewrites nothing.

UPDATE mc.pins p SET archon_sha = m.archon_sha
FROM (
  SELECT q.sha, min(a.archon_sha) AS archon_sha
  FROM mc.pins q
  JOIN mc.arch_versions a
    ON length(a.archon_sha) = 40 AND starts_with(a.archon_sha, q.archon_sha)
  WHERE length(q.archon_sha) < 40
  GROUP BY q.sha
  HAVING count(DISTINCT a.archon_sha) = 1
) m
WHERE p.sha = m.sha;
