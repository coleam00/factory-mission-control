-- Open Archon attention items: a run paused on a `wait: attention` node, with the question,
-- choices and labels Archon recorded in metadata.wait. One row per open item, kept by triggers on
-- Archon's run table by Archon's own rule for an open item (status paused, no metadata.source_release,
-- wait.kind attention, no wait.answer). Read-only like every other projection: each trigger body
-- catches every error into mc.projection_errors and never fails or waits on an Archon write
-- (lock_timeout 100 ms). The message is cut at 4000 characters, at most 16,000 bytes, so one live
-- value stays under the size a live query can answer; the console holds the whole message.
-- Idempotent: the backfill projects the runs already paused and changes nothing run again.

CREATE TABLE IF NOT EXISTS mc.attention_items (
  run_id uuid PRIMARY KEY,
  factory text NOT NULL,
  workflow_name text NOT NULL,
  node_id text NOT NULL,
  occurrence text,
  waiting_since timestamptz NOT NULL,
  form text NOT NULL,
  options jsonb NOT NULL,
  labels jsonb NOT NULL,
  message text NOT NULL
);

CREATE INDEX IF NOT EXISTS attention_items_factory ON mc.attention_items (factory);

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
  v_form text;
BEGIN
  IF p_status IS DISTINCT FROM 'paused'
     OR p_metadata ? 'source_release'
     OR jsonb_typeof(v_wait) IS DISTINCT FROM 'object'
     OR v_wait ->> 'kind' IS DISTINCT FROM 'attention'
     OR v_wait ? 'answer'
     OR btrim(coalesce(v_wait ->> 'message', '')) = '' THEN
    DELETE FROM mc.attention_items WHERE run_id = p_run_id;
    RETURN;
  END IF;
  v_codebase := (SELECT c.name FROM public.remote_agent_codebases c WHERE c.id = p_codebase_id);
  v_form := coalesce(v_wait ->> 'form', 'message');
  INSERT INTO mc.attention_items AS a (run_id, factory, workflow_name, node_id, occurrence,
    waiting_since, form, options, labels, message)
  VALUES (
    p_run_id,
    coalesce(
      (SELECT f.name FROM mc.factories f WHERE f.codebase = v_codebase ORDER BY f.name LIMIT 1),
      v_codebase,
      ''),
    p_workflow,
    CASE WHEN v_wait ->> 'owner' = 'loop_group'
      THEN (v_wait ->> 'nodeId') || '.' || (v_wait ->> 'bodyWaitId')
      ELSE v_wait ->> 'nodeId' END,
    v_wait ->> 'pauseId',
    (v_wait ->> 'waitingSince')::timestamptz,
    v_form,
    CASE v_form
      WHEN 'message' THEN '[]'::jsonb
      WHEN 'approval' THEN '[{"id":"approve"},{"id":"reject"}]'::jsonb
      ELSE CASE WHEN jsonb_typeof(v_wait -> 'options') = 'array'
        THEN v_wait -> 'options' ELSE '[]'::jsonb END
    END,
    CASE WHEN jsonb_typeof(v_wait -> 'labels') = 'object'
      THEN v_wait -> 'labels' ELSE '{}'::jsonb END,
    left(v_wait ->> 'message', 4000))
  ON CONFLICT (run_id) DO UPDATE SET
    factory = EXCLUDED.factory,
    workflow_name = EXCLUDED.workflow_name,
    node_id = EXCLUDED.node_id,
    occurrence = EXCLUDED.occurrence,
    waiting_since = EXCLUDED.waiting_since,
    form = EXCLUDED.form,
    options = EXCLUDED.options,
    labels = EXCLUDED.labels,
    message = EXCLUDED.message;
END;
$$;

CREATE OR REPLACE FUNCTION mc.project_attention() RETURNS trigger LANGUAGE plpgsql
SET lock_timeout = '100ms' AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM mc.attention_items WHERE run_id = OLD.id;
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

CREATE OR REPLACE TRIGGER mc_project_attention_insert
  AFTER INSERT ON public.remote_agent_workflow_runs
  FOR EACH ROW WHEN (NEW.status = 'paused')
  EXECUTE FUNCTION mc.project_attention();

CREATE OR REPLACE TRIGGER mc_project_attention_update
  AFTER UPDATE ON public.remote_agent_workflow_runs
  FOR EACH ROW WHEN (
    OLD.status IS DISTINCT FROM NEW.status
    OR OLD.codebase_id IS DISTINCT FROM NEW.codebase_id
    OR OLD.workflow_name IS DISTINCT FROM NEW.workflow_name
    OR OLD.metadata -> 'wait' IS DISTINCT FROM NEW.metadata -> 'wait'
    OR (OLD.metadata ? 'source_release') IS DISTINCT FROM (NEW.metadata ? 'source_release'))
  EXECUTE FUNCTION mc.project_attention();

CREATE OR REPLACE TRIGGER mc_project_attention_delete
  AFTER DELETE ON public.remote_agent_workflow_runs
  FOR EACH ROW WHEN (OLD.status = 'paused')
  EXECUTE FUNCTION mc.project_attention();

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
        PERFORM mc.record_projection_error('0019_attention_items', r.id, NULL,
          v_sqlstate, v_message);
      END IF;
    END;
  END LOOP;
END;
$$;
