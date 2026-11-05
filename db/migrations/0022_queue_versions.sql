-- Versions from queue runs (#378, the owner's 2026-11-04 ruling). A version is a digest that this
-- factory's archon-loop or archon-build-queue runs ran, dated by the earliest start among them. A
-- digest covers every workflow run from one source, so a version made by build-queue runs also
-- names that source's intake and merge-queue runs. No other workflow dates a version (#160): an
-- archon-manager run of an old loop's digest would move a loop version's first run earlier.
-- mc.dates_version owns the list; the live queries may not call an mc function, so they restate it
-- and db/queries.test.ts binds them. A digest only loop runs ran keeps its first_run_at and pin.
--
-- 0006's invariants hold: the functions only compare, the version block keeps its own exception
-- handler, and mc.project_version stops a lock wait after 100 ms. The backfill writes the versions
-- that build-queue runs already have; run again, it changes nothing.

CREATE OR REPLACE FUNCTION mc.dates_version(p_workflow text)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(p_workflow IN ('archon-loop', 'archon-build-queue'), false)
$$;

-- Writes a factory's version of a digest by the rule above, or deletes it when no run that dates a version ran it; true
-- when it wrote a row. A version that already reads right takes no row lock, so a run's later
-- updates never contend on it.
CREATE OR REPLACE FUNCTION mc.project_version(p_factory text, p_digest text)
RETURNS boolean LANGUAGE plpgsql
SET lock_timeout = '100ms' AS $$
DECLARE
  v_first timestamptz;
  v_pin text;
  v_written integer;
BEGIN
  SELECT min(l.started_at) INTO v_first FROM mc.laps l
  WHERE l.factory = p_factory AND l.digest = p_digest AND mc.dates_version(l.workflow_name)
    AND EXISTS (SELECT 1 FROM mc.factories f WHERE f.name = l.factory);
  IF v_first IS NULL THEN
    DELETE FROM mc.versions v WHERE v.factory = p_factory AND v.digest = p_digest;
    GET DIAGNOSTICS v_written = ROW_COUNT;
    RETURN v_written > 0;
  END IF;
  v_pin := mc.version_pin(v_first);
  IF EXISTS (SELECT 1 FROM mc.versions v WHERE v.factory = p_factory AND v.digest = p_digest
      AND v.first_run_at = v_first AND v.pin_sha IS NOT DISTINCT FROM v_pin) THEN
    RETURN false;
  END IF;
  INSERT INTO mc.versions AS v (factory, digest, first_run_at, pin_sha)
  VALUES (p_factory, p_digest, v_first, v_pin)
  ON CONFLICT (factory, digest) DO UPDATE SET
    first_run_at = EXCLUDED.first_run_at,
    pin_sha = EXCLUDED.pin_sha
  WHERE (v.first_run_at, v.pin_sha) IS DISTINCT FROM (EXCLUDED.first_run_at, EXCLUDED.pin_sha);
  GET DIAGNOSTICS v_written = ROW_COUNT;
  RETURN v_written > 0;
END;
$$;

-- 0019's run projection, with the version rule above in place of archon-loop alone.
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
    IF mc.dates_version(v_was_workflow) AND v_was_digest IS NOT NULL
        AND (v_was_factory, v_was_digest, v_was_workflow)
          IS DISTINCT FROM (v_factory, v_digest, NEW.workflow_name) THEN
      PERFORM mc.project_version(v_was_factory, v_was_digest);
    END IF;
    IF mc.dates_version(NEW.workflow_name) AND v_digest IS NOT NULL THEN
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

SELECT mc.project_version(d.factory, d.digest)
FROM (
  SELECT DISTINCT l.factory, l.digest FROM mc.laps l
  WHERE l.workflow_name = 'archon-build-queue' AND l.digest IS NOT NULL
) d;
