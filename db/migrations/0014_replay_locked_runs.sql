-- A run whose projection lost a lock wait is projected again (issue #152). When Archon writes a run
-- while its lap row or mc.laps is locked, mc.project_run gives up after its lock_timeout, records a
-- 55P03 under its trigger's name and lets Archon's write commit (0006, #117). A finished run gets no
-- more writes, so nothing projected it again and its lane stayed running. mc.replay_locked_runs()
-- replays each run with such an error that Archon is not running, through mc.project_run itself by
-- way of a temp table carrying the same trigger, and marks the errors it replayed. A lap row that
-- is still locked is skipped, as is a replay that loses any lock wait or records an error: its
-- errors stay unreplayed for the next call. `reconcile:laps` calls it on the owner's schedule.
-- Archon's tables are only read.

ALTER TABLE mc.projection_errors ADD COLUMN IF NOT EXISTS replayed_at timestamptz;

-- The number of runs it replayed.
CREATE OR REPLACE FUNCTION mc.replay_locked_runs() RETURNS integer LANGUAGE plpgsql
SET lock_timeout = '100ms' AS $$
DECLARE
  v_last bigint;
  v_run uuid;
  v_replayed integer := 0;
BEGIN
  v_last := (SELECT coalesce(max(id), 0) FROM mc.projection_errors);
  CREATE TEMP TABLE IF NOT EXISTS mc_replay_runs
    (LIKE public.remote_agent_workflow_runs) ON COMMIT DROP;
  CREATE OR REPLACE TRIGGER mc_replay_run AFTER INSERT ON mc_replay_runs
    FOR EACH ROW EXECUTE FUNCTION mc.project_run();
  FOR v_run IN
    SELECT DISTINCT p.run_id FROM mc.projection_errors p
      JOIN public.remote_agent_workflow_runs r ON r.id = p.run_id
     WHERE p.source IN ('mc_project_run_insert', 'mc_project_run_update')
       AND p.sqlstate = '55P03' AND p.replayed_at IS NULL AND p.id <= v_last
       AND r.status NOT IN ('pending', 'running')
  LOOP
    BEGIN
      IF EXISTS (SELECT 1 FROM mc.laps WHERE run_id = v_run) THEN
        PERFORM 1 FROM mc.laps WHERE run_id = v_run FOR UPDATE SKIP LOCKED;
        CONTINUE WHEN NOT FOUND;
      END IF;
      DELETE FROM mc_replay_runs;
      INSERT INTO mc_replay_runs SELECT * FROM public.remote_agent_workflow_runs WHERE id = v_run;
      IF EXISTS (SELECT 1 FROM mc.projection_errors WHERE source = 'mc_replay_run' AND id > v_last)
      THEN
        RAISE EXCEPTION 'replay of run % recorded an error', v_run;
      END IF;
      UPDATE mc.projection_errors SET replayed_at = now()
       WHERE run_id = v_run AND source IN ('mc_project_run_insert', 'mc_project_run_update')
         AND sqlstate = '55P03' AND replayed_at IS NULL AND id <= v_last;
      v_replayed := v_replayed + 1;
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
  END LOOP;
  RETURN v_replayed;
END;
$$;
