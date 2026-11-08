-- Why a run stopped (issue #513): mc.run_stops holds one row per stopped run of any workflow: the
-- step that failed or asked, its error line or the question, a class, and a signature that makes
-- alike failures one group. v3's Attention Fix group (#516) and the run page (#518) read it.
-- The live queries may not call an mc function (db/queries/REALTIME.md), so the class and signature
-- are computed here, at projection time, and stored. The five classes refine PRD 4.8's causes:
-- mc.stop_class tries PRD 4.8's three patterns first, on the same raw text causeOf reads, so what
-- app/lib/health.ts causeOf calls usage-limit or infrastructure is transient and what it calls
-- authentication is config.
-- Like 0006's functions the writers never raise and wait at most 100 ms for a lock: they run in
-- Archon's write transaction (fired from mc.project_run and mc.project_step_event's writes). The
-- triggers sit on mc's own tables, so Archon's tables gain none (PRD 6.1).
-- Run again, it changes nothing.

CREATE TABLE IF NOT EXISTS mc.run_stops (
  run_id uuid PRIMARY KEY,
  factory text NOT NULL,
  workflow_name text NOT NULL,
  status text NOT NULL CHECK (status IN ('completed', 'failed', 'cancelled', 'paused')),
  step_id text,
  line text,
  class text CHECK (class IN ('transient', 'environment', 'config', 'code', 'input')),
  signature text,
  stopped_at timestamptz,
  stopped_day date
);
CREATE INDEX IF NOT EXISTS run_stops_factory_failed ON mc.run_stops (factory, signature) WHERE status = 'failed';

-- transient, environment, config, code or input; NULL when no pattern matches. The first match wins.
-- PRD 4.8's three patterns read the raw text, as causeOf does; the others read it with run ids and
-- shas removed, so a hex run in an id cannot spell a word. The texts only a git refusal, a failed
-- merge or the check harness produce come before the code arm, because those lines carry branch and
-- file names that can spell a code word. The code arm then precedes the weak environment words: a
-- failing test whose line names a worktree path is still a code failure. It reads the text with
-- ids, paths and shas removed in stop_signature's order, so a path that carries an id is removed whole.
CREATE OR REPLACE FUNCTION mc.stop_class(p_error text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_error ~* 'usage limit|429' THEN 'transient'
    WHEN p_error ~* '401|unauthor' THEN 'config'
    WHEN p_error ~* 'ECONN|ETIMEDOUT|fetch failed' THEN 'transient'
    WHEN e IS NULL THEN NULL
    WHEN e ~* 'deadlock detected|usage or credit limit|rate.?limit|too many requests|overloaded|HTTP 5[0-9]{2}|\m5[0-9]{2} (bad gateway|gateway|service unavailable|internal server)|bad gateway|gateway time-?out|service unavailable|ENOTFOUND|connection terminated|timeout exceeded when trying to connect|provider reported transient' THEN 'transient'
    WHEN e ~* 'provider reported auth|authenticat|configuration must be fixed|bad credentials|missing binding|no binding|binding [^ ]+ (is )?(missing|not set|undefined)|no schedule|schedule [^ ]+ (is )?(missing|not found)' THEN 'config'
    WHEN e ~* 'no issue matched|no matching issue|bad argument|invalid argument|unknown (option|argument)|missing required input' THEN 'input'
    WHEN e ~* 'check must write|not a git repository|push [^ ]+ refused|refused: |non-fast-forward|fetch first|\[rejected\]|merge --no-edit' THEN 'environment'
    WHEN ep ~* 'tests? failed|\m[0-9]+ (tests? )?fail|failing tests?|typecheck|type errors?|error TS[0-9]+|app check failed|app-check .*(FAIL|red)|finding|\mFAIL\M' THEN 'code'
    WHEN e ~* 'did not complete|no such file or directory|ENOSPC|no space left|worktree|checkout|stale' THEN 'environment'
  END
  FROM (SELECT e, regexp_replace(regexp_replace(regexp_replace(left(p_error, 8000),
      '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', '<id>', 'gi'),
      '(?:\m[a-z]:)?(?:[[:alnum:]_.@~<>-]*[/\\])+[[:alnum:]_.@~<>-]*', ' ', 'gi'),
      '\m(?=[0-9a-f]*[0-9])(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\M', ' ', 'g') AS ep
    FROM (SELECT nullif(btrim(regexp_replace(regexp_replace(left(p_error, 8000),
      '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', ' ', 'g'),
      '\m(?=[0-9a-f]*[0-9])(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\M', ' ', 'g')), '') AS e) y) x
$$;

CREATE OR REPLACE FUNCTION mc.stop_line(p_text text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT left(btrim(substring(p_text FROM '[^\r\n]*\S[^\r\n]*')), 500)
$$;

CREATE OR REPLACE FUNCTION mc.stop_signature(p_workflow text, p_step text, p_line text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT p_workflow || ' · ' || coalesce(p_step, '') || ' · ' || left(btrim(
    regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(
      lower(coalesce(p_line, '')),
      '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', '<id>', 'g'),
      '(?:\m[a-z]:)?(?:[[:alnum:]_.@~<>-]*[/\\])+[[:alnum:]_.@~<>-]*', '<path>', 'g'),
      '\m(?=[0-9a-f]*[0-9])(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\M', '<sha>', 'g'),
      '[0-9]+', '<n>', 'g'),
      '\s+', ' ', 'g')), 300)
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
  v_line := mc.stop_line(v_text);
  v_at := coalesce(l.completed_at, v_at);
  INSERT INTO mc.run_stops AS r VALUES (p_run_id, l.factory, l.workflow_name, l.status, v_step, v_line,
    CASE WHEN l.status = 'failed' THEN mc.stop_class(v_text) END,
    CASE WHEN l.status = 'failed' THEN mc.stop_signature(l.workflow_name, v_step, v_line) END,
    v_at, (v_at AT TIME ZONE 'UTC')::date)
  ON CONFLICT (run_id) DO UPDATE SET factory = EXCLUDED.factory, workflow_name = EXCLUDED.workflow_name,
    status = EXCLUDED.status, step_id = EXCLUDED.step_id, line = EXCLUDED.line, class = EXCLUDED.class,
    signature = EXCLUDED.signature, stopped_at = EXCLUDED.stopped_at, stopped_day = EXCLUDED.stopped_day
  WHERE (r.factory, r.workflow_name, r.status, r.step_id, r.line, r.class, r.signature, r.stopped_at)
    IS DISTINCT FROM (EXCLUDED.factory, EXCLUDED.workflow_name, EXCLUDED.status, EXCLUDED.step_id,
      EXCLUDED.line, EXCLUDED.class, EXCLUDED.signature, EXCLUDED.stopped_at);
END $$;

CREATE OR REPLACE FUNCTION mc.project_run_stop_trigger() RETURNS trigger LANGUAGE plpgsql
SET lock_timeout = '100ms' AS $$
BEGIN
  PERFORM mc.project_run_stop(CASE WHEN TG_OP = 'DELETE' THEN OLD.run_id ELSE NEW.run_id END);
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  PERFORM mc.record_projection_error(TG_NAME, CASE WHEN TG_OP = 'DELETE' THEN OLD.run_id ELSE NEW.run_id END, NULL, SQLSTATE, SQLERRM);
  RETURN NULL;
END $$;

CREATE OR REPLACE TRIGGER run_stops_lap_insert AFTER INSERT ON mc.laps FOR EACH ROW
  EXECUTE FUNCTION mc.project_run_stop_trigger();
CREATE OR REPLACE TRIGGER run_stops_lap_update AFTER UPDATE ON mc.laps FOR EACH ROW
  WHEN ((OLD.status, OLD.completed_at, OLD.factory, OLD.workflow_name)
    IS DISTINCT FROM (NEW.status, NEW.completed_at, NEW.factory, NEW.workflow_name))
  EXECUTE FUNCTION mc.project_run_stop_trigger();
CREATE OR REPLACE TRIGGER run_stops_lap_delete AFTER DELETE ON mc.laps FOR EACH ROW
  EXECUTE FUNCTION mc.project_run_stop_trigger();
CREATE OR REPLACE TRIGGER run_stops_step_insert AFTER INSERT ON mc.lap_steps FOR EACH ROW
  WHEN (NEW.status = 'failed') EXECUTE FUNCTION mc.project_run_stop_trigger();
CREATE OR REPLACE TRIGGER run_stops_step_update AFTER UPDATE ON mc.lap_steps FOR EACH ROW
  WHEN ((OLD.status = 'failed' OR NEW.status = 'failed')
    AND (OLD.status, OLD.error, OLD.completed_at) IS DISTINCT FROM (NEW.status, NEW.error, NEW.completed_at))
  EXECUTE FUNCTION mc.project_run_stop_trigger();
CREATE OR REPLACE TRIGGER run_stops_step_delete AFTER DELETE ON mc.lap_steps FOR EACH ROW
  WHEN (OLD.status = 'failed') EXECUTE FUNCTION mc.project_run_stop_trigger();
CREATE OR REPLACE TRIGGER run_stops_attention AFTER INSERT OR UPDATE OR DELETE ON mc.attention_items
  FOR EACH ROW EXECUTE FUNCTION mc.project_run_stop_trigger();

DO $$
DECLARE r record; v_sqlstate text; v_message text;
BEGIN
  FOR r IN SELECT run_id FROM mc.laps LOOP
    BEGIN
      PERFORM mc.project_run_stop(r.run_id);
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_message = MESSAGE_TEXT;
      v_sqlstate := SQLSTATE;
      IF NOT EXISTS (SELECT 1 FROM mc.projection_errors p
        WHERE p.run_id = r.run_id AND p.sqlstate = v_sqlstate AND p.message = v_message) THEN
        PERFORM mc.record_projection_error('0031_run_stops', r.run_id, NULL, v_sqlstate, v_message);
      END IF;
    END;
  END LOOP;
END $$;
