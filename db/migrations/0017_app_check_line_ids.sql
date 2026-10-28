-- A check-app line keeps its report line id (issue #184). A review disposition names the line it
-- answers by that id (`H2 blocks`), and the merge gate joins the two by it, but 0005 stored lines
-- by position only, so the one-lap page could not show which line a disposition answers. The id
-- is assigned by the agent, not by kind and order (a merge conflict reports a lone `C0`, a retest
-- carries lines over), so it is stored rather than derived.
--
-- Only the id's leading letters and digits are kept, normalized as mc.step_output keeps a
-- disposition's line, so both sides compare equal and no free text from an agent that reads the
-- holdout scenarios fits in the column. 0005, 0006 and 0014 are applied on main and never re-run,
-- so the change is here. Lines projected before it keep a null id. Run again, it changes nothing.

ALTER TABLE mc.app_check_lines ADD COLUMN IF NOT EXISTS line_id text;

ALTER TABLE mc.app_check_lines DROP CONSTRAINT IF EXISTS app_check_lines_line_id_check;
ALTER TABLE mc.app_check_lines ADD CONSTRAINT app_check_lines_line_id_check
  CHECK (line_id ~ '^[A-Z]+[0-9]+$');

-- A check-app report's lines, by 1-based position, without their text: each line keeps its report
-- id's leading letters and digits, upper-cased, a holdout line keeps only the first H-<nn> in its
-- text, or `unidentified` (PRD 6.3, 11.7), matched as parsers/metrics.ts holdoutId matches
-- /\bH-\d{2,}\b/, and every line keeps whether it is pre-existing and only its citation's
-- references. An empty kind reads as a defect, as the merge gate's readAppCheck reads it.
CREATE OR REPLACE FUNCTION mc.project_app_check_lines(p_run_id uuid, p_lines jsonb)
RETURNS void LANGUAGE plpgsql
SET lock_timeout = '100ms' AS $fn$
BEGIN
  INSERT INTO mc.app_check_lines AS a
    (run_id, position, line_id, kind, verdict, evidence_count, pre_existing, pre_existing_refs,
     scenario_id)
  SELECT
    p_run_id,
    l.position,
    upper(substring(mc.gate_trim(coalesce(l.line ->> 'id', '')) FROM '^[A-Za-z]+[0-9]+')),
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
    line_id = EXCLUDED.line_id,
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
