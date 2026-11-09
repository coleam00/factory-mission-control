-- The line a stopped run shows is its most specific failure message (issue #560). 0031 took the first
-- non-blank line, which for a script node is a source excerpt ("Script node 'prepare' failed [exit 1]:
-- 28 | }") and not the message. A failed run's line is now, in this order: the first line starting
-- `error:` or `Error:`; else the first line where `failed:` follows a command or node name; else the
-- first non-blank line. A paused run's line is its question's first line as before: a question body can
-- carry a line such as "- CI failed: lint" that must not be lifted over its title.
-- mc.stop_class still reads the whole text, so classes do not change. A changed line changes
-- mc.stop_signature, so the groups of multi-line failures re-form once, here; single-line failures keep
-- their line and signature. Like 0031 it never raises into Archon's write and, run again, changes nothing.

CREATE OR REPLACE FUNCTION mc.stop_first_line(p_text text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT left(btrim(substring(p_text FROM '[^\r\n]*\S[^\r\n]*')), 500)
$$;

CREATE OR REPLACE FUNCTION mc.stop_line(p_text text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT left(btrim(coalesce(
    substring(p_text FROM '(?:^|[\r\n])[ \t]*((?:error|Error):[^\r\n]*)'),
    substring(p_text FROM '(?:^|[\r\n])([^\r\n]*\S[ \t]+failed:[^\r\n]*)'),
    mc.stop_first_line(p_text))), 500)
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
    CASE WHEN l.status = 'failed' THEN mc.stop_class(v_text) END,
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
        PERFORM mc.record_projection_error('0032_stop_line', r.run_id, NULL, v_sqlstate, v_message);
      END IF;
    END;
  END LOOP;
END $$;
