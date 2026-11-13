-- Issue #664: 27 of 67 failed runs were still unclassified after 20261112T2001Z. Six lines get a class:
-- the factory host could not start processes (a user32 DLL failure, a failed git config) is environment;
-- a pull request that moved while the app check prepared ("changed before preparation") is transient, the
-- next check retries; an item outside a buildable stage and a claim that moved to another run are input.
-- "head/base" reads as a path to mc.stop_strip, so the moved-PR arm matches the words after it.
-- A failed run with no stop line that never started a node (no mc.lap_steps row but skipped ones) is
-- environment, decided in mc.project_run_stop because mc.stop_class sees only text. mc.lap_steps is
-- written only for workflows mc.projects_step_events lists, so for any other workflow an empty one says
-- nothing and the run stays unclassified, as does a run with no line that did start a node.
-- Stored classes are re-projected once, as 20261112T2001Z did. Like it, this never raises into Archon's
-- write and, run again, changes nothing.

CREATE OR REPLACE FUNCTION mc.stop_class(p_error text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN r ~* 'usage limit|\m(http|status|error)[ :]*(code[ :]*)?429\M|\m429 (status|too many)' THEN 'transient'
    WHEN r ~* '\m(http|status|error)[ :]*(code[ :]*)?401\M|\m401 (status|oauth|unauthor)|unauthor' THEN 'config'
    WHEN r ~* 'ECONN|ETIMEDOUT|fetch failed' THEN 'transient'
    WHEN e IS NULL THEN NULL
    WHEN e ~* 'usage or credit limit|rate.?limit|too many requests|overloaded|HTTP 5[0-9]{2}|\m5[0-9]{2} (bad gateway|gateway|service unavailable|internal server)|bad gateway|gateway time-?out|service unavailable|ENOTFOUND|connection terminated|timeout exceeded when trying to connect|provider reported transient|couldn.?t connect to compute node|failed to connect to|dial tcp|connectex|handshake failed|changed before preparation' THEN 'transient'
    WHEN e ~* 'provider reported auth|authenticat|configuration must be fixed|bad credentials|missing binding|no binding|binding [^ ]+ (is )?(missing|not set|undefined)|no schedule|schedule [^ ]+ (is )?(missing|not found)' THEN 'config'
    WHEN e ~* 'no issue matched|no matching issue|bad argument|invalid argument|unknown (option|argument)|missing required input|is claimed by run|could not resolve to an? (issue|pull request)|does not wait for the build queue|is no longer claimed by this run' THEN 'input'
    WHEN e ~* 'out of memory|deadlock detected|check must write|not a git repository|push [^ ]+ refused|refused: |non-fast-forward|fetch first|\[rejected\]|merge --no-edit|failed to load user32|dynamic link library|git config --' THEN 'environment'
    WHEN e ~* 'is not one of the choices' THEN 'code'
    WHEN ep ~* 'tests? failed|\m[0-9]+ (tests? )?fail|failing tests?|typecheck|type errors?|error TS[0-9]+|app check failed|app-check .*(FAIL|red)|finding|\mFAIL\M' THEN 'code'
    WHEN e ~* 'did not complete|no such file or directory|ENOSPC|no space left|worktree|checkout|stale' THEN 'environment'
  END
  FROM (SELECT e, r, mc.stop_strip(left(p_error, 8000), '<id>', ' ', ' ') AS ep
    FROM (SELECT regexp_replace(left(p_error, 8000), '(#|\m(pulls?|issues?)/|\mPRs? ?#?)[0-9]+', ' ', 'gi') AS r,
      nullif(btrim(mc.stop_strip(left(p_error, 8000), ' ', '\&', ' ')), '') AS e) y) x
$$;

CREATE OR REPLACE FUNCTION mc.project_run_stop(p_run_id uuid)
RETURNS void LANGUAGE plpgsql SET lock_timeout = '100ms' AS $$
DECLARE
  l record; v_step text; v_text text; v_at timestamptz; v_line text;
BEGIN
  SELECT factory, workflow_name, status, completed_at INTO l FROM mc.laps WHERE run_id = p_run_id;
  IF NOT FOUND OR l.status NOT IN ('completed', 'failed', 'cancelled', 'paused') THEN
    DELETE FROM mc.run_stops WHERE run_id = p_run_id;
    RETURN;
  END IF;
  IF l.status = 'failed' THEN
    SELECT s.step_id, s.error, s.completed_at INTO v_step, v_text, v_at FROM mc.lap_steps s
    WHERE s.run_id = p_run_id AND s.status = 'failed'
    ORDER BY s.completed_at DESC NULLS LAST, s.step_id LIMIT 1;
  ELSIF l.status = 'paused' THEN
    SELECT a.node_id, a.message, a.waiting_since INTO v_step, v_text, v_at
    FROM mc.attention_items a WHERE a.run_id = p_run_id;
  END IF;
  v_line := CASE WHEN l.status = 'failed' THEN mc.stop_line(v_text) ELSE mc.stop_first_line(v_text) END;
  v_at := coalesce(l.completed_at, v_at);
  INSERT INTO mc.run_stops AS r VALUES (p_run_id, l.factory, l.workflow_name, l.status, v_step, v_line,
    CASE WHEN l.status = 'failed' THEN coalesce(mc.stop_class(v_text),
      CASE WHEN v_line IS NULL AND mc.projects_step_events(l.workflow_name) AND NOT EXISTS (SELECT 1 FROM mc.lap_steps s
        WHERE s.run_id = p_run_id AND s.status <> 'skipped') THEN 'environment' END) END,
    CASE WHEN l.status = 'failed' THEN mc.stop_signature(l.workflow_name, v_step, v_line) END,
    v_at)
  ON CONFLICT (run_id) DO UPDATE SET factory = EXCLUDED.factory, workflow_name = EXCLUDED.workflow_name,
    status = EXCLUDED.status, step_id = EXCLUDED.step_id, line = EXCLUDED.line, class = EXCLUDED.class,
    signature = EXCLUDED.signature, stopped_at = EXCLUDED.stopped_at
  WHERE (r.factory, r.workflow_name, r.status, r.step_id, r.line, r.class, r.signature, r.stopped_at)
    IS DISTINCT FROM (EXCLUDED.factory, EXCLUDED.workflow_name, EXCLUDED.status, EXCLUDED.step_id,
      EXCLUDED.line, EXCLUDED.class, EXCLUDED.signature, EXCLUDED.stopped_at);
END $$;

DO $$
DECLARE r record; v_sqlstate text; v_message text;
BEGIN
  FOR r IN SELECT run_id FROM mc.laps WHERE status = 'failed' LOOP
    BEGIN
      PERFORM mc.project_run_stop(r.run_id);
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_message = MESSAGE_TEXT;
      v_sqlstate := SQLSTATE;
      IF NOT EXISTS (SELECT 1 FROM mc.projection_errors p
        WHERE p.run_id = r.run_id AND p.sqlstate = v_sqlstate AND p.message = v_message) THEN
        PERFORM mc.record_projection_error('20261113T1200Z_classify_host_and_unlined_failures', r.run_id, NULL, v_sqlstate, v_message);
      END IF;
    END;
  END LOOP;
END $$;

-- The no-line arm above reads every non-skipped step row, so those writes re-project the stop too.
CREATE OR REPLACE TRIGGER run_stops_step_insert AFTER INSERT ON mc.lap_steps FOR EACH ROW
  WHEN (NEW.status <> 'skipped') EXECUTE FUNCTION mc.project_run_stop_trigger();
CREATE OR REPLACE TRIGGER run_stops_step_update AFTER UPDATE ON mc.lap_steps FOR EACH ROW
  WHEN (((OLD.status = 'failed' OR NEW.status = 'failed')
      AND (OLD.status, OLD.error, OLD.completed_at) IS DISTINCT FROM (NEW.status, NEW.error, NEW.completed_at))
    OR (OLD.status = 'skipped') <> (NEW.status = 'skipped'))
  EXECUTE FUNCTION mc.project_run_stop_trigger();
CREATE OR REPLACE TRIGGER run_stops_step_delete AFTER DELETE ON mc.lap_steps FOR EACH ROW
  WHEN (OLD.status <> 'skipped') EXECUTE FUNCTION mc.project_run_stop_trigger();
