-- The state Archon's queues keep for each work item (document `work/<n>` in its state store), reduced
-- to the six fields the Board reads to tell a parked item from a queued one. One row per live
-- document, kept by a trigger on Archon's append-only revision table: the latest revision wins, a
-- delete revision removes the row. Read-only like every other projection: the trigger catches every
-- error into mc.projection_errors and never fails or waits on an Archon write (lock_timeout 100 ms).
-- The trigger and backfill exist only where Archon has the state table (the `fixture` branch that
-- check branches fork from predates it). Idempotent: the backfill changes nothing run again.

CREATE TABLE IF NOT EXISTS mc.work_item_states (
  project_key text NOT NULL,
  number integer NOT NULL,
  revision integer NOT NULL,
  build_status text,
  build_at text,
  merge_status text,
  merge_at text,
  triage_at text,
  own_pr_at text,
  PRIMARY KEY (project_key, number)
);

CREATE OR REPLACE FUNCTION mc.project_work_item_state(
  p_project_key text, p_name text, p_revision integer, p_value text
) RETURNS void LANGUAGE plpgsql
SET lock_timeout = '100ms' AS $$
DECLARE
  v_number integer := substring(p_name FROM '^work/([1-9][0-9]{0,8})$')::integer;
  v_facts jsonb;
BEGIN
  IF v_number IS NULL THEN RETURN; END IF;
  IF p_value IS NULL THEN
    DELETE FROM mc.work_item_states
    WHERE project_key = p_project_key AND number = v_number AND revision < p_revision;
    RETURN;
  END IF;
  v_facts := p_value::jsonb -> 'facts';
  INSERT INTO mc.work_item_states AS s (project_key, number, revision, build_status, build_at,
    merge_status, merge_at, triage_at, own_pr_at)
  VALUES (p_project_key, v_number, p_revision,
    v_facts -> 'build' ->> 'status', v_facts -> 'build' ->> 'at',
    v_facts -> 'merge' ->> 'status', v_facts -> 'merge' ->> 'at',
    v_facts -> 'triage' ->> 'at', v_facts -> 'own_pr' ->> 'at')
  ON CONFLICT (project_key, number) DO UPDATE SET
    revision = EXCLUDED.revision,
    build_status = EXCLUDED.build_status, build_at = EXCLUDED.build_at,
    merge_status = EXCLUDED.merge_status, merge_at = EXCLUDED.merge_at,
    triage_at = EXCLUDED.triage_at, own_pr_at = EXCLUDED.own_pr_at
  WHERE s.revision < EXCLUDED.revision;
END;
$$;

CREATE OR REPLACE FUNCTION mc.project_work_item_state_revision() RETURNS trigger LANGUAGE plpgsql
SET lock_timeout = '100ms' AS $$
BEGIN
  PERFORM mc.project_work_item_state(NEW.project_key, NEW.name, NEW.revision, NEW.value);
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  PERFORM mc.record_projection_error(TG_NAME, NULL, NULL, SQLSTATE, NEW.name || ': ' || SQLERRM);
  RETURN NULL;
END;
$$;

DO $$
DECLARE
  r record;
  v_sqlstate text;
  v_message text;
BEGIN
  IF to_regclass('public.remote_agent_state_revisions') IS NULL THEN RETURN; END IF;
  EXECUTE 'CREATE OR REPLACE TRIGGER mc_project_work_item_state
    AFTER INSERT ON public.remote_agent_state_revisions
    FOR EACH ROW WHEN (NEW.name LIKE ''work/%'')
    EXECUTE FUNCTION mc.project_work_item_state_revision()';
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
        PERFORM mc.record_projection_error('0028_work_item_states', NULL, NULL,
          v_sqlstate, v_message);
      END IF;
    END;
  END LOOP;
END;
$$;
