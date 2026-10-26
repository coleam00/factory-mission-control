-- Versions (PRD 11.2), projected: a version is a function of mc.laps and mc.pins. For a factory
-- named in mc.factories and a digest, its first_run_at is the earliest start of that factory's
-- archon-loop laps with that digest, and its pin_sha the latest pin committed before that. The run
-- trigger writes it as Archon writes the run, a pin write relabels every version, and
-- `reconcile:laps` writes it for runs projected before this migration. Every writer applies the same
-- rule, so they agree in any order. No stored data is changed here.
--
-- 0006's invariant holds: the version part of the run trigger runs in its own exception block, and
-- mc.project_version stops a lock wait after 100 ms.

-- The pin a version first run at this time ran under: the latest committed before it.
CREATE OR REPLACE FUNCTION mc.version_pin(p_first_run_at timestamptz)
RETURNS text LANGUAGE sql STABLE AS $$
  SELECT p.sha FROM mc.pins p WHERE p.committed_at < p_first_run_at
  ORDER BY p.committed_at DESC, p.sha DESC LIMIT 1
$$;

-- Writes a factory's version of a digest by the rule above; true when it wrote a row. A version
-- that already reads right takes no row lock, so a run's later updates never contend on it.
CREATE OR REPLACE FUNCTION mc.project_version(p_factory text, p_digest text)
RETURNS boolean LANGUAGE plpgsql
SET lock_timeout = '100ms' AS $$
DECLARE
  v_first timestamptz;
  v_pin text;
  v_written integer;
BEGIN
  SELECT min(l.started_at) INTO v_first FROM mc.laps l
  WHERE l.factory = p_factory AND l.digest = p_digest AND l.workflow_name = 'archon-loop'
    AND EXISTS (SELECT 1 FROM mc.factories f WHERE f.name = l.factory);
  IF v_first IS NULL THEN
    RETURN false;
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

-- 0006's lap projection, then the run's version. A version that cannot be written is recorded on
-- its own and keeps the lap.
CREATE OR REPLACE FUNCTION mc.project_run() RETURNS trigger LANGUAGE plpgsql
SET lock_timeout = '100ms' AS $$
DECLARE
  v_codebase text;
  v_factory text;
  v_digest text;
BEGIN
  v_codebase := (SELECT c.name FROM public.remote_agent_codebases c WHERE c.id = NEW.codebase_id);
  v_factory := coalesce(
    (SELECT f.name FROM mc.factories f WHERE f.codebase = v_codebase ORDER BY f.name LIMIT 1),
    v_codebase,
    '');
  v_digest := NEW.metadata -> 'workflow_source' ->> 'digest';
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
  IF NEW.workflow_name = 'archon-loop' AND v_digest IS NOT NULL THEN
    BEGIN
      PERFORM mc.project_version(v_factory, v_digest);
    EXCEPTION WHEN OTHERS THEN
      PERFORM mc.record_projection_error(TG_NAME, NEW.id, NULL, SQLSTATE, SQLERRM);
    END;
  END IF;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  PERFORM mc.record_projection_error(TG_NAME, NEW.id, NULL, SQLSTATE, SQLERRM);
  RETURN NULL;
END;
$$;

-- Runs in the transaction of whoever writes the pin (the webhook, backfill), never in Archon's, so
-- it waits for a lock rather than lose the pin.
CREATE OR REPLACE FUNCTION mc.label_versions() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE mc.versions v SET pin_sha = mc.version_pin(v.first_run_at)
  WHERE v.pin_sha IS DISTINCT FROM mc.version_pin(v.first_run_at);
  RETURN NULL;
END;
$$;

CREATE OR REPLACE TRIGGER mc_label_versions
  AFTER INSERT OR UPDATE OR DELETE ON mc.pins
  FOR EACH STATEMENT
  EXECUTE FUNCTION mc.label_versions();
