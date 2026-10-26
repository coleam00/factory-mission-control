-- 0008's mc.project_run, with the lap it read held in scalars rather than a variable of mc.laps's
-- row type (issue #114). PL/pgSQL resolves a declared row type when it compiles the function, on a
-- session's first call, and reading it takes a lock on mc.laps under the function's lock_timeout
-- before any exception block is entered: a lock another session held there (a migration's ALTER
-- TABLE) failed Archon's write instead of being recorded. A projection function declares no
-- variable of a table's row type, so every lock it takes is taken by a statement its exception
-- blocks catch (0006's invariant 1).

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
    (run_id, factory, workflow_name, status, digest, started_at, completed_at)
  VALUES (
    NEW.id,
    v_factory,
    NEW.workflow_name,
    NEW.status,
    v_digest,
    NEW.started_at,
    NEW.completed_at)
  ON CONFLICT (run_id) DO UPDATE SET
    factory = EXCLUDED.factory,
    workflow_name = EXCLUDED.workflow_name,
    status = EXCLUDED.status,
    digest = EXCLUDED.digest,
    started_at = EXCLUDED.started_at,
    completed_at = EXCLUDED.completed_at;
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
