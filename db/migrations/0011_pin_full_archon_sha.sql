-- Pins hold the full Archon sha, or none yet (issue #157). Before this, a pin stored the sha its
-- commit subject named (`Pin Archon ee4e0231: ...`), while every mc.arch_* row is keyed by the full
-- 40-character sha, so the home map, the step screens and the architecture diff, which join on
-- equality, found no architecture for it. The webhook and backfill now store the full sha from the
-- pin commit's template/factory/pack.json. When the webhook cannot read that file, it stores the
-- pin with a null archon_sha, so the version strip, labels and decisions show it at once, and the
-- next backfill fills the sha in (owner decision on #157). A non-null archon_sha is always full.
--
-- A short pin already stored becomes the one parsed Archon sha it prefixes. A prefix that matches
-- several parsed versions, or none, becomes null for the next backfill, so it keeps reading "No
-- architecture is recorded" and never shows another version's architecture. Run again, it changes
-- nothing.

ALTER TABLE mc.pins ALTER COLUMN archon_sha DROP NOT NULL;

UPDATE mc.pins p SET archon_sha = m.archon_sha
FROM (
  SELECT q.sha, min(a.archon_sha) AS archon_sha
  FROM mc.pins q
  JOIN mc.arch_versions a
    ON a.archon_sha ~ '^[0-9a-f]{40}$' AND starts_with(a.archon_sha, q.archon_sha)
  WHERE q.archon_sha !~ '^[0-9a-f]{40}$'
  GROUP BY q.sha
  HAVING count(DISTINCT a.archon_sha) = 1
) m
WHERE p.sha = m.sha;

UPDATE mc.pins SET archon_sha = NULL WHERE archon_sha !~ '^[0-9a-f]{40}$';
