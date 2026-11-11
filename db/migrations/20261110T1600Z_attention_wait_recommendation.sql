-- Attention reads the recommendation and the options' effects Archon now stores as data (Archon
-- #5367): `metadata.wait.recommendation` `{option, why, confidence?}` and each option's `does` and
-- `value`. mc.project_attention_item takes `recommended`, `confidence` and the new
-- `recommendation_why` together from `recommendation` when its option is one of the offered options
-- (`confidence` is null when it has none); otherwise 0031's reading of the message's Recommendation
-- line stays (waits recorded before the upgrade). An option's `description` comes from its non-empty
-- `does`, else per option from its choice line. `recommendation_why` is null without a structured
-- recommendation; the browser then reads the reason from the message. `does` and `value` are not stored: `does` is `description`, `value`
-- is opaque and never shown. This supersedes 0031's "Archon's wait carries none of these".
-- Read-only like 0031 (errors into mc.projection_errors, lock_timeout 100 ms). Idempotent: the
-- backfill reprojects what Archon already stored.

ALTER TABLE mc.attention_items ADD COLUMN IF NOT EXISTS recommendation_why text;

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
  v_rec jsonb := v_wait -> 'recommendation';
  v_why text;
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
        v_description := CASE WHEN jsonb_typeof(v_option -> 'does') = 'string'
          AND btrim(v_option ->> 'does') <> '' THEN v_option ->> 'does' END;
        IF v_description IS NULL THEN
          FOR v_line IN SELECT l FROM unnest(string_to_array(v_message, E'\n')) l LOOP
            IF starts_with(v_line, v_prefix) THEN
              v_description := substr(v_line, length(v_prefix) + 1);
              EXIT;
            END IF;
          END LOOP;
        END IF;
        v_options := v_options || jsonb_build_array(CASE WHEN v_description IS NULL
          THEN v_option - 'does' - 'value'
          ELSE (v_option - 'does' - 'value') || jsonb_build_object('description', v_description) END);
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

    IF jsonb_typeof(v_rec) = 'object' AND EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_options) e WHERE e ->> 'id' = v_rec ->> 'option') THEN
      v_recommended := v_rec ->> 'option';
      v_confidence := v_rec ->> 'confidence';
      v_why := nullif(btrim(v_rec ->> 'why'), '');
    END IF;

    INSERT INTO mc.attention_items AS a (run_id, factory, workflow_name, node_id,
      waiting_since, form, options, labels, message, occurrence_id, item_number, recommended,
      confidence, recommendation_why)
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
      v_confidence,
      v_why)
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
      confidence = EXCLUDED.confidence,
      recommendation_why = EXCLUDED.recommendation_why;
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
        PERFORM mc.record_projection_error('20261110T1600Z_attention_wait_recommendation', r.id, NULL,
          v_sqlstate, v_message);
      END IF;
    END;
  END LOOP;
END;
$$;
