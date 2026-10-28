-- A check-app line keeps whether it cited a pre-existing failure and only the references its
-- citation names, never the citation itself (issue #153). 0006 stored `pre_existing` word for
-- word, and the citation is free text from an agent that reads the holdout scenarios, while
-- engineering.md rules that holdout scenario text never enters the dashboard's tables: ids and
-- verdicts only. `pre_existing` is now whether the trimmed citation is non-empty, which is all the
-- catch count and the merge gate read, and `pre_existing_refs` holds the run ids, 40-character
-- commit SHAs and issue or pull request numbers it names.
--
-- 0005 and 0006 are applied on main and never re-run, so the change is here. A stored citation is
-- converted in place: it is the trimmed report field, so it yields the row a re-projection would.
-- Run again, it changes nothing.

-- The distinct references in a citation, sorted: whole UUIDs (run ids) and whole 40-hex SHAs,
-- lower-cased, and `#<n>` from `#<n>` or a `/issues/<n>` or `/pull/<n>` URL. Nothing else is kept.
CREATE OR REPLACE FUNCTION mc.citation_refs(p_citation text)
RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(array_agg(DISTINCT r.ref ORDER BY r.ref), '{}')
  FROM (
    SELECT lower(m[1]) AS ref FROM regexp_matches(p_citation,
      '(?<![0-9A-Za-z])([0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12})(?![0-9A-Za-z])', 'g') AS m
    UNION
    SELECT lower(m[1]) FROM regexp_matches(p_citation,
      '(?<![0-9A-Za-z])([0-9A-Fa-f]{40})(?![0-9A-Za-z])', 'g') AS m
    UNION
    SELECT '#' || m[1] FROM regexp_matches(p_citation,
      '(?:(?<![0-9A-Za-z_&])#|/(?:issues|pull)/)([1-9][0-9]{0,9})(?![0-9A-Za-z_])', 'g') AS m
  ) r
$$;

ALTER TABLE mc.app_check_lines ADD COLUMN IF NOT EXISTS pre_existing_refs text[] NOT NULL DEFAULT '{}';

-- The type change rewrites the table, so no stored citation text is left behind.
DO $$
BEGIN
  IF (SELECT data_type FROM information_schema.columns WHERE table_schema = 'mc'
      AND table_name = 'app_check_lines' AND column_name = 'pre_existing') = 'text' THEN
    UPDATE mc.app_check_lines SET pre_existing_refs = mc.citation_refs(pre_existing);
    ALTER TABLE mc.app_check_lines ALTER COLUMN pre_existing DROP DEFAULT;
    ALTER TABLE mc.app_check_lines ALTER COLUMN pre_existing TYPE boolean USING pre_existing <> '';
    ALTER TABLE mc.app_check_lines ALTER COLUMN pre_existing SET DEFAULT false;
  END IF;
END
$$;

-- Stored references re-parse to themselves, so no free text fits in the column.
ALTER TABLE mc.app_check_lines DROP CONSTRAINT IF EXISTS app_check_lines_pre_existing_refs_check;
ALTER TABLE mc.app_check_lines ADD CONSTRAINT app_check_lines_pre_existing_refs_check CHECK (
  pre_existing_refs = mc.citation_refs(array_to_string(pre_existing_refs, ' '))
  AND (pre_existing OR cardinality(pre_existing_refs) = 0));

-- A check-app report's lines, by 1-based position, without their text: a holdout line keeps only
-- the first H-<nn> in its text, or `unidentified` (PRD 6.3, 11.7), matched as parsers/metrics.ts
-- holdoutId matches /\bH-\d{2,}\b/, and every line keeps whether it is pre-existing and only its
-- citation's references. An empty kind reads as a defect, as the merge gate's readAppCheck reads
-- it.
CREATE OR REPLACE FUNCTION mc.project_app_check_lines(p_run_id uuid, p_lines jsonb)
RETURNS void LANGUAGE plpgsql
SET lock_timeout = '100ms' AS $fn$
BEGIN
  INSERT INTO mc.app_check_lines AS a
    (run_id, position, kind, verdict, evidence_count, pre_existing, pre_existing_refs, scenario_id)
  SELECT
    p_run_id,
    l.position,
    k.kind,
    upper(mc.gate_trim(coalesce(l.line ->> 'verdict', ''))),
    CASE WHEN jsonb_typeof(l.line -> 'evidence') = 'array'
      THEN jsonb_array_length(l.line -> 'evidence') ELSE 0 END,
    c.citation <> '',
    mc.citation_refs(c.citation),
    CASE WHEN k.kind = 'holdout'
      THEN coalesce(
        substring(l.line ->> 'text' FROM '(?<![A-Za-z0-9_])H-[0-9]{2,}(?![A-Za-z0-9_])'),
        'unidentified') END
  FROM jsonb_array_elements(p_lines) WITH ORDINALITY AS l(line, position)
  CROSS JOIN LATERAL (SELECT coalesce(nullif(mc.gate_trim(l.line ->> 'kind'), ''), 'defect') AS kind) k
  CROSS JOIN LATERAL (SELECT mc.gate_trim(coalesce(l.line ->> 'pre_existing', '')) AS citation) c
  ON CONFLICT (run_id, position) DO UPDATE SET
    kind = EXCLUDED.kind,
    verdict = EXCLUDED.verdict,
    evidence_count = EXCLUDED.evidence_count,
    pre_existing = EXCLUDED.pre_existing,
    pre_existing_refs = EXCLUDED.pre_existing_refs,
    scenario_id = EXCLUDED.scenario_id;
  DELETE FROM mc.app_check_lines
  WHERE run_id = p_run_id AND position > jsonb_array_length(p_lines);
END;
$fn$;
