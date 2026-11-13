-- Why a work item is parked, for the Attention card that asks the owner what to do with it. Read-only
-- like every other projection (invariant 1): the function keeps its lock_timeout of 100 ms and its
-- trigger keeps catching every error. mc.work_item_states gains
--   parked_reason  the `reason` of the decision that parked the item (the last decision of the parked
--                  build or merge fact); NULL when nothing is parked or the decision gave none.
-- Idempotent: the replay projects what Archon already stored and changes nothing run again.

ALTER TABLE mc.work_item_states ADD COLUMN IF NOT EXISTS parked_reason text;

CREATE OR REPLACE FUNCTION mc.project_work_item_state(
  p_project_key text, p_name text, p_revision integer, p_value text
) RETURNS void LANGUAGE plpgsql
SET lock_timeout = '100ms' AS $$
DECLARE
  v_number integer := substring(p_name FROM '^work/([1-9][0-9]{0,8})$')::integer;
  v_doc jsonb;
  v_facts jsonb;
  v_claim text;
  v_entry jsonb;
  v_text text;
  v_reason text;
BEGIN
  IF v_number IS NULL THEN RETURN; END IF;
  IF p_value IS NULL THEN
    DELETE FROM mc.work_item_states
    WHERE project_key = p_project_key AND number = v_number AND revision < p_revision;
    IF FOUND THEN
      DELETE FROM mc.work_item_blockers WHERE project_key = p_project_key AND number = v_number;
    END IF;
    RETURN;
  END IF;
  v_doc := p_value::jsonb;
  v_facts := v_doc -> 'facts';
  v_claim := v_doc -> 'claim' ->> 'run_id';
  v_entry := CASE
    WHEN v_facts -> 'build' ->> 'status' = 'parked' THEN v_facts -> 'build' -> 'decisions' -> -1
    WHEN v_facts -> 'merge' ->> 'status' = 'parked' THEN v_facts -> 'merge' -> 'decisions' -> -1
  END;
  v_reason := v_entry ->> 'reason';
  INSERT INTO mc.work_item_states AS s (project_key, number, revision, build_status, build_at,
    merge_status, merge_at, triage_at, own_pr_at, stage, claim_run_id, parked_reason)
  VALUES (p_project_key, v_number, p_revision,
    v_facts -> 'build' ->> 'status', v_facts -> 'build' ->> 'at',
    v_facts -> 'merge' ->> 'status', v_facts -> 'merge' ->> 'at',
    v_facts -> 'triage' ->> 'at', v_facts -> 'own_pr' ->> 'at',
    v_doc ->> 'stage',
    CASE WHEN v_claim ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      THEN v_claim::uuid END,
    v_reason)
  ON CONFLICT (project_key, number) DO UPDATE SET
    revision = EXCLUDED.revision,
    build_status = EXCLUDED.build_status, build_at = EXCLUDED.build_at,
    merge_status = EXCLUDED.merge_status, merge_at = EXCLUDED.merge_at,
    triage_at = EXCLUDED.triage_at, own_pr_at = EXCLUDED.own_pr_at,
    stage = EXCLUDED.stage, claim_run_id = EXCLUDED.claim_run_id,
    parked_reason = EXCLUDED.parked_reason
  WHERE s.revision <= EXCLUDED.revision;
  IF FOUND THEN
    DELETE FROM mc.work_item_blockers WHERE project_key = p_project_key AND number = v_number;
    IF v_entry IS NOT NULL THEN
      v_text := coalesce(v_entry ->> 'reason', '') || E'\n' || coalesce(v_entry -> 'answer' ->> 'text', '');
      INSERT INTO mc.work_item_blockers (project_key, number, blocker)
      SELECT DISTINCT p_project_key, v_number, m[1]::integer
      FROM regexp_matches(v_text, '#([1-9][0-9]{0,8})\M', 'g') m
      WHERE m[1]::integer <> v_number;
    END IF;
  END IF;
END;
$$;

DO $$
DECLARE
  r record;
  v_sqlstate text;
  v_message text;
BEGIN
  IF to_regclass('public.remote_agent_state_revisions') IS NULL THEN RETURN; END IF;
  FOR r IN EXECUTE 'SELECT DISTINCT ON (project_key, name) project_key, name, revision, value
      FROM public.remote_agent_state_revisions WHERE name LIKE ''work/%''
      ORDER BY project_key, name, revision DESC'
  LOOP
    BEGIN
      PERFORM mc.project_work_item_state(r.project_key, r.name, r.revision, r.value);
    EXCEPTION WHEN OTHERS THEN
      v_sqlstate := SQLSTATE;
      v_message := r.name || ': ' || SQLERRM;
      IF NOT EXISTS (SELECT 1 FROM mc.projection_errors p
        WHERE p.sqlstate = v_sqlstate AND p.message = v_message) THEN
        PERFORM mc.record_projection_error('20261112T2005Z_parked_reason', NULL, NULL,
          v_sqlstate, v_message);
      END IF;
    END;
  END LOOP;
END;
$$;
