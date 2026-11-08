-- The data the v3 Attention home reads: the structured question behind each open attention item, and
-- the work that stopped moving. Read-only like every other projection (invariant 1): the same
-- functions and triggers that 0019 and 0028 created keep the new columns and tables, each trigger
-- body catches every error into mc.projection_errors, and none fails or waits on an Archon write
-- (lock_timeout 100 ms). No trigger is added to Archon's tables. Idempotent: the backfills project
-- what Archon already stored and change nothing run again.
--
-- mc.attention_items gains
--   occurrence_id  Archon's `attentionOccurrence`: the wait's pauseId, else `legacy:<step>` where the
--                  step is node_id. The value `archon workflow ... --occurrence` accepts.
--   item_number    the number the pack's title names (`Build queue, issue N:`, `Merge queue, PR N:`),
--                  else the run's `number` input, else null.
--   recommended, confidence
--                  the id and the word of the message's `**Recommendation: `<id>`** (<word> confidence)`
--                  line (the pack's renderAttention), kept only when the id is one of the options.
-- and each element of `options` may carry `description`: the rest of the message's
-- `- `<id>` (<label>): <description>` choice line. Archon's wait carries none of these, so the
-- rendered layout is the only source; a message without them leaves them null or absent.
--
-- mc.capacity_waits: a run Archon paused with the answer recorded and `metadata.capacity_wait.since`,
-- waiting for a slot. mc.work_item_states gains the document's `stage` and its `claim.run_id`.
-- mc.work_item_blockers: the `#n` items the decision that parked a work item names.

ALTER TABLE mc.attention_items ADD COLUMN IF NOT EXISTS occurrence_id text;
ALTER TABLE mc.attention_items ADD COLUMN IF NOT EXISTS item_number integer;
ALTER TABLE mc.attention_items ADD COLUMN IF NOT EXISTS recommended text;
ALTER TABLE mc.attention_items ADD COLUMN IF NOT EXISTS confidence text;

CREATE TABLE IF NOT EXISTS mc.capacity_waits (
  run_id uuid PRIMARY KEY,
  factory text NOT NULL,
  workflow_name text NOT NULL,
  item_number integer,
  since timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS capacity_waits_factory ON mc.capacity_waits (factory);

ALTER TABLE mc.work_item_states ADD COLUMN IF NOT EXISTS stage text;
ALTER TABLE mc.work_item_states ADD COLUMN IF NOT EXISTS claim_run_id uuid;

CREATE TABLE IF NOT EXISTS mc.work_item_blockers (
  project_key text NOT NULL,
  number integer NOT NULL,
  blocker integer NOT NULL,
  PRIMARY KEY (project_key, number, blocker)
);

CREATE OR REPLACE FUNCTION mc.project_attention_item(
  p_run_id uuid,
  p_codebase_id uuid,
  p_workflow text,
  p_status text,
  p_metadata jsonb
) RETURNS void LANGUAGE plpgsql
SET lock_timeout = '100ms' AS $$
DECLARE
  v_wait jsonb := p_metadata -> 'wait';
  v_codebase text;
  v_factory text;
  v_form text;
  v_message text := v_wait ->> 'message';
  v_node text;
  v_title text;
  v_item integer;
  v_options jsonb := '[]'::jsonb;
  v_option jsonb;
  v_prefix text;
  v_description text;
  v_line text;
  v_recommended text;
  v_confidence text;
  v_since timestamptz;
  v_answered boolean;
BEGIN
  v_answered := p_status = 'paused'
    AND NOT p_metadata ? 'source_release'
    AND jsonb_typeof(v_wait) = 'object'
    AND v_wait ->> 'kind' = 'attention'
    AND v_wait ? 'answer';
  v_codebase := (SELECT c.name FROM public.remote_agent_codebases c WHERE c.id = p_codebase_id);
  v_factory := coalesce(mc.factory_of_codebase(v_codebase), v_codebase, '');

  v_title := substring(v_message FROM '^\*\*([^*\n]+)\*\*');
  v_item := substring(v_title FROM '^[A-Z][a-z]+ queue, (?:issue|PR) ([1-9][0-9]{0,8}):')::integer;
  IF v_item IS NULL AND (p_metadata -> 'inputs' ->> 'number') ~ '^[1-9][0-9]{0,8}$' THEN
    v_item := (p_metadata -> 'inputs' ->> 'number')::integer;
  END IF;
  IF p_status IS DISTINCT FROM 'paused'
     OR p_metadata ? 'source_release'
     OR jsonb_typeof(v_wait) IS DISTINCT FROM 'object'
     OR v_wait ->> 'kind' IS DISTINCT FROM 'attention'
     OR v_wait ? 'answer'
     OR btrim(coalesce(v_message, '')) = '' THEN
    DELETE FROM mc.attention_items WHERE run_id = p_run_id;
  ELSE
    v_form := coalesce(v_wait ->> 'form', 'message');
    v_node := CASE WHEN v_wait ->> 'owner' = 'loop_group'
      THEN (v_wait ->> 'nodeId') || '.' || (v_wait ->> 'bodyWaitId')
      ELSE v_wait ->> 'nodeId' END;

    IF v_form IN ('message', 'approval') OR jsonb_typeof(v_wait -> 'options') IS DISTINCT FROM 'array' THEN
      v_options := CASE v_form
        WHEN 'approval' THEN '[{"id":"approve"},{"id":"reject"}]'::jsonb
        ELSE '[]'::jsonb END;
    ELSE
      FOR v_option IN SELECT e FROM jsonb_array_elements(v_wait -> 'options') e LOOP
        v_prefix := '- `' || (v_option ->> 'id') || '` (' || coalesce(v_option ->> 'label', '') || '): ';
        v_description := NULL;
        FOR v_line IN SELECT l FROM unnest(string_to_array(v_message, E'\n')) l LOOP
          IF starts_with(v_line, v_prefix) THEN
            v_description := substr(v_line, length(v_prefix) + 1);
            EXIT;
          END IF;
        END LOOP;
        v_options := v_options || jsonb_build_array(CASE WHEN v_description IS NULL THEN v_option
          ELSE v_option || jsonb_build_object('description', v_description) END);
      END LOOP;
      v_recommended := substring(v_message FROM '\*\*Recommendation: `([^`]+)`\*\*');
      IF v_recommended IS NOT NULL AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(v_options) e WHERE e ->> 'id' = v_recommended) THEN
        v_confidence := substring(v_message
          FROM '\*\*Recommendation: `[^`]+`\*\* \(([a-z]+) confidence\)');
      ELSE
        v_recommended := NULL;
      END IF;
    END IF;

    INSERT INTO mc.attention_items AS a (run_id, factory, workflow_name, node_id,
      waiting_since, form, options, labels, message, occurrence_id, item_number, recommended,
      confidence)
    VALUES (
      p_run_id,
      v_factory,
      p_workflow,
      v_node,
      (v_wait ->> 'waitingSince')::timestamptz,
      v_form,
      v_options,
      CASE WHEN jsonb_typeof(v_wait -> 'labels') = 'object'
        THEN v_wait -> 'labels' ELSE '{}'::jsonb END,
      left(v_message, 4000),
      coalesce(v_wait ->> 'pauseId', 'legacy:' || v_node),
      v_item,
      v_recommended,
      v_confidence)
    ON CONFLICT (run_id) DO UPDATE SET
      factory = EXCLUDED.factory,
      workflow_name = EXCLUDED.workflow_name,
      node_id = EXCLUDED.node_id,
      waiting_since = EXCLUDED.waiting_since,
      form = EXCLUDED.form,
      options = EXCLUDED.options,
      labels = EXCLUDED.labels,
      message = EXCLUDED.message,
      occurrence_id = EXCLUDED.occurrence_id,
      item_number = EXCLUDED.item_number,
      recommended = EXCLUDED.recommended,
      confidence = EXCLUDED.confidence;
  END IF;

  IF v_answered AND jsonb_typeof(p_metadata -> 'capacity_wait') = 'object' THEN
    BEGIN
      v_since := (p_metadata -> 'capacity_wait' ->> 'since')::timestamptz;
    EXCEPTION WHEN OTHERS THEN
      PERFORM mc.record_projection_error('mc.project_attention_item', p_run_id, NULL, SQLSTATE, SQLERRM);
      v_since := NULL;
    END;
  END IF;
  IF v_since IS NOT NULL THEN
    INSERT INTO mc.capacity_waits (run_id, factory, workflow_name, item_number, since)
    VALUES (p_run_id, v_factory, p_workflow, v_item, v_since)
    ON CONFLICT (run_id) DO UPDATE SET
      factory = EXCLUDED.factory,
      workflow_name = EXCLUDED.workflow_name,
      item_number = EXCLUDED.item_number,
      since = EXCLUDED.since;
  ELSE
    DELETE FROM mc.capacity_waits WHERE run_id = p_run_id;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION mc.project_attention() RETURNS trigger LANGUAGE plpgsql
SET lock_timeout = '100ms' AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM mc.attention_items WHERE run_id = OLD.id;
    DELETE FROM mc.capacity_waits WHERE run_id = OLD.id;
  ELSE
    PERFORM mc.project_attention_item(NEW.id, NEW.codebase_id, NEW.workflow_name, NEW.status,
      NEW.metadata);
  END IF;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  PERFORM mc.record_projection_error(TG_NAME, coalesce(NEW.id, OLD.id), NULL, SQLSTATE, SQLERRM);
  RETURN NULL;
END;
$$;

CREATE OR REPLACE TRIGGER mc_project_attention_update
  AFTER UPDATE ON public.remote_agent_workflow_runs
  FOR EACH ROW WHEN (
    OLD.status IS DISTINCT FROM NEW.status
    OR OLD.codebase_id IS DISTINCT FROM NEW.codebase_id
    OR OLD.workflow_name IS DISTINCT FROM NEW.workflow_name
    OR OLD.metadata -> 'wait' IS DISTINCT FROM NEW.metadata -> 'wait'
    OR OLD.metadata -> 'capacity_wait' IS DISTINCT FROM NEW.metadata -> 'capacity_wait'
    OR (OLD.metadata ? 'source_release') IS DISTINCT FROM (NEW.metadata ? 'source_release'))
  EXECUTE FUNCTION mc.project_attention();

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
  INSERT INTO mc.work_item_states AS s (project_key, number, revision, build_status, build_at,
    merge_status, merge_at, triage_at, own_pr_at, stage, claim_run_id)
  VALUES (p_project_key, v_number, p_revision,
    v_facts -> 'build' ->> 'status', v_facts -> 'build' ->> 'at',
    v_facts -> 'merge' ->> 'status', v_facts -> 'merge' ->> 'at',
    v_facts -> 'triage' ->> 'at', v_facts -> 'own_pr' ->> 'at',
    v_doc ->> 'stage',
    CASE WHEN v_claim ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      THEN v_claim::uuid END)
  ON CONFLICT (project_key, number) DO UPDATE SET
    revision = EXCLUDED.revision,
    build_status = EXCLUDED.build_status, build_at = EXCLUDED.build_at,
    merge_status = EXCLUDED.merge_status, merge_at = EXCLUDED.merge_at,
    triage_at = EXCLUDED.triage_at, own_pr_at = EXCLUDED.own_pr_at,
    stage = EXCLUDED.stage, claim_run_id = EXCLUDED.claim_run_id
  WHERE s.revision <= EXCLUDED.revision;
  IF FOUND THEN
    DELETE FROM mc.work_item_blockers WHERE project_key = p_project_key AND number = v_number;
    v_entry := CASE
      WHEN v_facts -> 'build' ->> 'status' = 'parked' THEN v_facts -> 'build' -> 'decisions' -> -1
      WHEN v_facts -> 'merge' ->> 'status' = 'parked' THEN v_facts -> 'merge' -> 'decisions' -> -1
    END;
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
  FOR r IN
    SELECT id, codebase_id, workflow_name, status, metadata
    FROM public.remote_agent_workflow_runs WHERE status = 'paused'
  LOOP
    BEGIN
      PERFORM mc.project_attention_item(r.id, r.codebase_id, r.workflow_name, r.status, r.metadata);
    EXCEPTION WHEN OTHERS THEN
      v_sqlstate := SQLSTATE;
      v_message := SQLERRM;
      IF NOT EXISTS (SELECT 1 FROM mc.projection_errors p
        WHERE p.run_id = r.id AND p.sqlstate = v_sqlstate AND p.message = v_message) THEN
        PERFORM mc.record_projection_error('0031_attention_data', r.id, NULL,
          v_sqlstate, v_message);
      END IF;
    END;
  END LOOP;
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
        PERFORM mc.record_projection_error('0031_attention_data', NULL, NULL,
          v_sqlstate, v_message);
      END IF;
    END;
  END LOOP;
END;
$$;
