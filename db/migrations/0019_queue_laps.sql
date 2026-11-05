-- What a queue run shows on the factory map (issue #333). A run of Archon's queue workflows has no
-- claim comment, so the issue it works is its `number` input, which Archon keeps on the run row's
-- metadata.inputs; and a run waiting on a person is a paused run whose metadata.wait is an open
-- attention wait. The home map reads both from the dashboard's own tables, so the lap carries them:
-- issue_number (null for a run with no issue number, or one for a pull request) and attention_open.
-- Neither stores any text of the wait (MISSION rule 3).
-- 0009's mc.project_run sets them on every write. The two functions only compare and cast, so they
-- cannot raise inside Archon's write (0006's invariant 1); the trigger's WHEN also fires on a change
-- of the inputs, the wait or the source release, so answering an attention item, which writes
-- wait.answer while the run stays paused, drops the chip on the answer. 0006 and 0009 are applied
-- on main and never re-run, so the columns, functions and trigger are added here; the backfill
-- fills laps projected before this file. Run again, it changes nothing.

ALTER TABLE mc.laps ADD COLUMN IF NOT EXISTS issue_number integer;
ALTER TABLE mc.laps ADD COLUMN IF NOT EXISTS attention_open boolean NOT NULL DEFAULT false;

-- The issue a run works: its `number` input, unless the run's `kind` input says it is a pull request.
CREATE OR REPLACE FUNCTION mc.run_issue_number(p_metadata jsonb)
RETURNS integer LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN coalesce(p_metadata -> 'inputs' ->> 'kind', 'issue') = 'issue'
    AND (p_metadata -> 'inputs' ->> 'number') ~ '^[1-9][0-9]{0,8}$'
    THEN (p_metadata -> 'inputs' ->> 'number')::integer END
$$;

-- Archon's own rule for a run that waits on a person (pausedAttention in
-- packages/workflows/src/schemas/run-attention.ts): paused, not released from a source, and an
-- attention wait that has no answer yet.
CREATE OR REPLACE FUNCTION mc.run_attention_open(p_status text, p_metadata jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(p_status = 'paused'
    AND jsonb_typeof(p_metadata) = 'object'
    AND NOT p_metadata ? 'source_release'
    AND jsonb_typeof(p_metadata -> 'wait') = 'object'
    AND p_metadata -> 'wait' ->> 'kind' = 'attention'
    AND NOT p_metadata -> 'wait' ? 'answer', false)
$$;

CREATE OR REPLACE FUNCTION mc.project_run() RETURNS trigger LANGUAGE plpgsql
SET lock_timeout = '100ms' AS $$
DECLARE
  v_codebase text;
  v_factory text;
  v_digest text;
  v_was_factory text;
  v_was_digest text;
  v_was_workflow text;
BEGIN
  v_codebase := (SELECT c.name FROM public.remote_agent_codebases c WHERE c.id = NEW.codebase_id);
  v_factory := coalesce(
    (SELECT f.name FROM mc.factories f WHERE f.codebase = v_codebase ORDER BY f.name LIMIT 1),
    v_codebase,
    '');
  v_digest := NEW.metadata -> 'workflow_source' ->> 'digest';
  SELECT l.factory, l.digest, l.workflow_name INTO v_was_factory, v_was_digest, v_was_workflow
  FROM mc.laps l WHERE l.run_id = NEW.id;
  INSERT INTO mc.laps AS l
    (run_id, factory, workflow_name, status, digest, started_at, completed_at,
     issue_number, attention_open)
  VALUES (
    NEW.id,
    v_factory,
    NEW.workflow_name,
    NEW.status,
    v_digest,
    NEW.started_at,
    NEW.completed_at,
    mc.run_issue_number(NEW.metadata),
    mc.run_attention_open(NEW.status, NEW.metadata))
  ON CONFLICT (run_id) DO UPDATE SET
    factory = EXCLUDED.factory,
    workflow_name = EXCLUDED.workflow_name,
    status = EXCLUDED.status,
    digest = EXCLUDED.digest,
    started_at = EXCLUDED.started_at,
    completed_at = EXCLUDED.completed_at,
    issue_number = EXCLUDED.issue_number,
    attention_open = EXCLUDED.attention_open;
  BEGIN
    IF v_was_workflow = 'archon-loop' AND v_was_digest IS NOT NULL
        AND (v_was_factory, v_was_digest, v_was_workflow)
          IS DISTINCT FROM (v_factory, v_digest, NEW.workflow_name) THEN
      PERFORM mc.project_version(v_was_factory, v_was_digest);
    END IF;
    IF NEW.workflow_name = 'archon-loop' AND v_digest IS NOT NULL THEN
      PERFORM mc.project_version(v_factory, v_digest);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    PERFORM mc.record_projection_error(TG_NAME, NEW.id, NULL, SQLSTATE, SQLERRM);
  END;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  PERFORM mc.record_projection_error(TG_NAME, NEW.id, NULL, SQLSTATE, SQLERRM);
  RETURN NULL;
END;
$$;

-- Archon touches a running run's last_activity_at often; only a change a lap shows fires this.
-- Plain operators only: a WHEN that raised would fail Archon's write.
CREATE OR REPLACE TRIGGER mc_project_run_update
  AFTER UPDATE ON public.remote_agent_workflow_runs
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status
    OR OLD.workflow_name IS DISTINCT FROM NEW.workflow_name
    OR OLD.codebase_id IS DISTINCT FROM NEW.codebase_id
    OR OLD.started_at IS DISTINCT FROM NEW.started_at
    OR OLD.completed_at IS DISTINCT FROM NEW.completed_at
    OR OLD.metadata -> 'workflow_source' ->> 'digest'
      IS DISTINCT FROM NEW.metadata -> 'workflow_source' ->> 'digest'
    OR OLD.metadata -> 'inputs' IS DISTINCT FROM NEW.metadata -> 'inputs'
    OR OLD.metadata -> 'wait' IS DISTINCT FROM NEW.metadata -> 'wait'
    OR OLD.metadata -> 'source_release' IS DISTINCT FROM NEW.metadata -> 'source_release')
  EXECUTE FUNCTION mc.project_run();

UPDATE mc.laps l
SET issue_number = mc.run_issue_number(r.metadata),
    attention_open = mc.run_attention_open(r.status, r.metadata)
FROM public.remote_agent_workflow_runs r
WHERE r.id = l.run_id
  AND (l.issue_number, l.attention_open)
    IS DISTINCT FROM (mc.run_issue_number(r.metadata), mc.run_attention_open(r.status, r.metadata));
