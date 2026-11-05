-- A queue factory's app check reaches the map and the Board (issue #311). 0020 kept no output for
-- any `factory-app-check` step, because the workflow takes holdout scenarios as input, so the home
-- map's failing chip and the Board's verdict chip, which read the old loop's `check-app` step, had
-- nothing to count on a factory on the queues, and no line of its report was projected.
--
-- Now the run's `select` step keeps only its `pr` and `head`, and its `check` step keeps only
-- `overall` (PASS or FAIL) with that `pr` and `head`, so the two chips read them as they read
-- `check-app`. The check's lines are strings, `C1  PASS  <sentence>  evidence: <file>` (or P for a
-- probe, A for an assertion), and are stored in mc.app_check_lines the way the old loop's are:
-- id, kind, verdict and whether it cites evidence, never the sentence (MISSION rule 3).
--
-- A run with any holdout line (an id starting with H, or an H-<nn> anywhere in a line) keeps no
-- output at all and no lines, as 0020 kept none: its select output is cleared when its check
-- completes. Every other step of the workflow still keeps none.
--
-- Only mc.project_step_event changes, plus the functions below it calls; like 0020's it cannot
-- raise inside Archon's write (0006's invariant 1). Runs finished before this file are
-- re-projected at the end of it for the steps already stored, and `reconcile:laps` replays the
-- rest. Run again, it changes nothing.

ALTER TABLE mc.app_check_lines DROP CONSTRAINT IF EXISTS app_check_lines_kind_check;
ALTER TABLE mc.app_check_lines ADD CONSTRAINT app_check_lines_kind_check
  CHECK (kind IN ('criterion', 'holdout', 'probe', 'defect', 'assertion'));

-- Whether a check report's lines name a holdout. Lines that are not an array name none.
CREATE OR REPLACE FUNCTION mc.queue_app_check_has_holdout(p_lines jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(jsonb_typeof(p_lines) = 'array' AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_lines) AS l(line)
    WHERE jsonb_typeof(l.line) = 'string'
      AND (mc.gate_trim(l.line #>> '{}') ~* '^H[-0-9]'
        OR (l.line #>> '{}') ~ '(?<![A-Za-z0-9_])H-[0-9]{2,}(?![A-Za-z0-9_])')), false)
$$;

-- A check report's string lines as the objects mc.project_app_check_lines reads. The id and verdict
-- are the ones the factory's evidence.ts LINE accepts; any other line is left out.
CREATE OR REPLACE FUNCTION mc.queue_app_check_lines(p_lines jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
      'id', m.parts[1],
      'kind', CASE left(m.parts[1], 1)
        WHEN 'C' THEN 'criterion' WHEN 'P' THEN 'probe' ELSE 'assertion' END,
      'verdict', m.parts[2],
      'evidence', CASE WHEN l.line #>> '{}' ~ 'evidence:\s*\S'
        THEN jsonb_build_array('evidence') ELSE '[]'::jsonb END)
    ORDER BY l.position), '[]'::jsonb)
  FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_lines) = 'array' THEN p_lines ELSE '[]' END)
    WITH ORDINALITY AS l(line, position)
  CROSS JOIN LATERAL (
    SELECT regexp_match(mc.gate_trim(l.line #>> '{}'), '^([CPA][0-9]+)\s{2}(PASS|FAIL|INCOMPLETE)\s{2}') AS parts
  ) m
  WHERE jsonb_typeof(l.line) = 'string' AND m.parts IS NOT NULL
$$;

-- What a `factory-app-check` step keeps: `select` its pull request and head, `check` its overall
-- verdict with the pull request and head the run's `select` step kept, and only when the report
-- names no holdout. Anything else keeps nothing.
CREATE OR REPLACE FUNCTION mc.app_check_step_output(p_run_id uuid, p_step text, p_output jsonb)
RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN jsonb_typeof(p_output) IS DISTINCT FROM 'object' THEN NULL
    WHEN p_step = 'select' THEN nullif(
      CASE WHEN p_output ->> 'pr' ~ '^[0-9]{1,9}$' THEN jsonb_build_object('pr', p_output -> 'pr')
        ELSE '{}'::jsonb END
      || CASE WHEN p_output ->> 'head' ~ '^[0-9a-f]{7,64}$'
        THEN jsonb_build_object('head', p_output -> 'head') ELSE '{}'::jsonb END,
      '{}'::jsonb)
    WHEN p_step = 'check' AND NOT mc.queue_app_check_has_holdout(p_output -> 'lines') THEN nullif(
      CASE WHEN p_output ->> 'overall' IN ('PASS', 'FAIL')
        THEN jsonb_build_object('overall', p_output -> 'overall') ELSE '{}'::jsonb END
      || coalesce((SELECT s.output FROM mc.lap_steps s
        WHERE s.run_id = p_run_id AND s.step_id = 'select'), '{}'::jsonb),
      '{}'::jsonb)
  END
$$;

CREATE OR REPLACE FUNCTION mc.project_step_event() RETURNS trigger LANGUAGE plpgsql
SET lock_timeout = '100ms' AS $$
DECLARE
  v_raw jsonb;
  v_parsed jsonb;
  v_output jsonb;
  v_started timestamptz;
  v_duration bigint;
  v_model text;
  v_workflow text;
BEGIN
  SELECT workflow_name INTO v_workflow FROM public.remote_agent_workflow_runs
  WHERE id = NEW.workflow_run_id;
  IF EXISTS (SELECT 1 FROM public.remote_agent_workflow_runs
    WHERE id = NEW.workflow_run_id AND NOT mc.projects_step_events(workflow_name)) THEN
    RETURN NULL;
  END IF;
  v_raw := NEW.data -> 'structured_output';
  v_parsed := mc.structured_output(v_raw);
  IF jsonb_typeof(v_raw) NOT IN ('object', 'null') AND v_parsed IS NULL THEN
    PERFORM mc.record_projection_error(TG_NAME, NEW.workflow_run_id, NEW.id, '22000',
      format('structured_output is a jsonb %s, not an object', jsonb_typeof(v_raw)));
  END IF;
  IF v_workflow = 'factory-app-check' THEN
    v_output := mc.app_check_step_output(NEW.workflow_run_id, NEW.step_name, v_parsed);
  ELSE
    v_output := mc.step_output(NEW.step_name, v_parsed);
    IF NOT mc.keeps_step_output(v_workflow) THEN
      v_output := NULL;
    END IF;
  END IF;
  v_started := (NEW.data -> 'timing' ->> 'startedAt')::timestamptz;
  v_duration := coalesce(NEW.data ->> 'duration_ms', NEW.data -> 'timing' ->> 'durationMs');
  v_model := coalesce(NEW.data -> 'model_usage' ->> 'resolved', NEW.data ->> 'model');

  IF NEW.event_type = 'node_started' THEN
    INSERT INTO mc.lap_steps AS s (run_id, step_id, status, started_at, provider, model)
    VALUES (NEW.workflow_run_id, NEW.step_name, 'running', v_started,
      NEW.data ->> 'provider', v_model)
    ON CONFLICT (run_id, step_id) DO UPDATE SET
      status = 'running',
      started_at = EXCLUDED.started_at,
      completed_at = NULL,
      duration_ms = NULL,
      provider = EXCLUDED.provider,
      model = EXCLUDED.model,
      tokens_input = NULL,
      tokens_output = NULL,
      tokens_cache_read = NULL,
      tokens_cache_write = NULL,
      cost_usd = NULL,
      error = NULL,
      output = NULL
    WHERE s.status = 'running' OR s.completed_at < EXCLUDED.started_at;
  ELSE
    INSERT INTO mc.lap_steps AS s (run_id, step_id, status, started_at, completed_at, duration_ms,
      provider, model, tokens_input, tokens_output, tokens_cache_read, tokens_cache_write,
      cost_usd, error, output)
    VALUES (
      NEW.workflow_run_id,
      NEW.step_name,
      substring(NEW.event_type FROM 6),
      v_started,
      coalesce(v_started + v_duration * interval '1 millisecond', NEW.created_at, now()),
      v_duration,
      NEW.data ->> 'provider',
      v_model,
      (NEW.data -> 'tokens' ->> 'input')::bigint,
      (NEW.data -> 'tokens' ->> 'output')::bigint,
      (NEW.data -> 'tokens' ->> 'cacheRead')::bigint,
      (NEW.data -> 'tokens' ->> 'cacheWrite')::bigint,
      (NEW.data ->> 'cost_usd')::numeric,
      NEW.data ->> 'error',
      v_output)
    ON CONFLICT (run_id, step_id) DO UPDATE SET
      status = EXCLUDED.status,
      started_at = coalesce(EXCLUDED.started_at, s.started_at),
      completed_at = EXCLUDED.completed_at,
      duration_ms = EXCLUDED.duration_ms,
      provider = coalesce(EXCLUDED.provider, s.provider),
      model = coalesce(EXCLUDED.model, s.model),
      tokens_input = EXCLUDED.tokens_input,
      tokens_output = EXCLUDED.tokens_output,
      tokens_cache_read = EXCLUDED.tokens_cache_read,
      tokens_cache_write = EXCLUDED.tokens_cache_write,
      cost_usd = EXCLUDED.cost_usd,
      error = EXCLUDED.error,
      output = EXCLUDED.output;
    BEGIN
      PERFORM mc.record_step_attempt(NEW.id, NEW.workflow_run_id, NEW.event_type, NEW.step_name,
        NEW.data);
    EXCEPTION WHEN OTHERS THEN
      PERFORM mc.record_projection_error(TG_NAME, NEW.workflow_run_id, NEW.id, SQLSTATE, SQLERRM);
    END;
    BEGIN
      PERFORM mc.record_attempt_usage(NEW.id, NEW.workflow_run_id, NEW.step_name, NEW.created_at,
        NEW.data);
    EXCEPTION WHEN OTHERS THEN
      PERFORM mc.record_projection_error(TG_NAME, NEW.workflow_run_id, NEW.id, SQLSTATE, SQLERRM);
    END;
    IF NEW.event_type = 'node_completed' AND NEW.step_name = 'check-app'
      AND v_parsed ? 'lines' THEN
      BEGIN
        PERFORM mc.project_app_check_lines(NEW.workflow_run_id,
          v_parsed -> 'lines');
      EXCEPTION WHEN OTHERS THEN
        PERFORM mc.record_projection_error(TG_NAME, NEW.workflow_run_id, NEW.id, SQLSTATE, SQLERRM);
      END;
    END IF;
    IF NEW.event_type = 'node_completed' AND NEW.step_name = 'check'
      AND v_workflow = 'factory-app-check' AND jsonb_typeof(v_parsed -> 'lines') = 'array' THEN
      BEGIN
        IF mc.queue_app_check_has_holdout(v_parsed -> 'lines') THEN
          UPDATE mc.lap_steps SET output = NULL
          WHERE run_id = NEW.workflow_run_id AND step_id = 'select';
        ELSE
          PERFORM mc.project_app_check_lines(NEW.workflow_run_id,
            mc.queue_app_check_lines(v_parsed -> 'lines'));
        END IF;
      EXCEPTION WHEN OTHERS THEN
        PERFORM mc.record_projection_error(TG_NAME, NEW.workflow_run_id, NEW.id, SQLSTATE, SQLERRM);
      END;
    END IF;
  END IF;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  PERFORM mc.record_projection_error(TG_NAME, NEW.workflow_run_id, NEW.id, SQLSTATE, SQLERRM);
  RETURN NULL;
END;
$$;

-- Backfill: the select and check steps already stored for finished runs of the workflow, in
-- Archon's order so a check reads the pull request its select kept.
DO $backfill$
DECLARE
  e record;
  v_parsed jsonb;
BEGIN
  FOR e IN
    SELECT ev.workflow_run_id AS run_id, ev.step_name, ev.data
    FROM public.remote_agent_workflow_events ev
    JOIN public.remote_agent_workflow_runs r ON r.id = ev.workflow_run_id
    WHERE r.workflow_name = 'factory-app-check' AND ev.event_type = 'node_completed'
      AND ev.step_name IN ('select', 'check')
      AND EXISTS (SELECT 1 FROM mc.lap_steps s
        WHERE s.run_id = ev.workflow_run_id AND s.step_id = ev.step_name)
    ORDER BY ev.created_at, coalesce(ev.event_order, 0), ev.id
  LOOP
    v_parsed := mc.structured_output(e.data -> 'structured_output');
    UPDATE mc.lap_steps SET output = mc.app_check_step_output(e.run_id, e.step_name, v_parsed)
    WHERE run_id = e.run_id AND step_id = e.step_name;
    IF e.step_name = 'check' AND jsonb_typeof(v_parsed -> 'lines') = 'array' THEN
      IF mc.queue_app_check_has_holdout(v_parsed -> 'lines') THEN
        UPDATE mc.lap_steps SET output = NULL WHERE run_id = e.run_id AND step_id = 'select';
      ELSE
        PERFORM mc.project_app_check_lines(e.run_id, mc.queue_app_check_lines(v_parsed -> 'lines'));
      END IF;
    END IF;
  END LOOP;
END
$backfill$;
