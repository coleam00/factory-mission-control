-- A step's structured_output that Archon stored as a jsonb string holding a JSON object is
-- projected as that object (issue #288), on the live trigger and on `reconcile:laps`' replay, which
-- runs the same functions. Any other value that is not an object is recorded as 22000 and projected
-- as null, as before. Without this, a replay of such a lap recorded a 22000 no live trigger had
-- recorded and `reconcile:laps` rolled the lap's repair back and exited 1.
--
-- 0006, 0013 and 0015 are applied on main and never re-run, so the change is here. No row is
-- rewritten: `reconcile:laps` repairs a finished lap projected before this file. Every statement is
-- CREATE OR REPLACE, so running it again changes nothing.

-- The object a structured_output holds, parsed from a JSON string if it is one; NULL otherwise.
-- The text is checked with pg_input_is_valid in its own statement so that no input can raise.
CREATE OR REPLACE FUNCTION mc.structured_output(p_output jsonb) RETURNS jsonb LANGUAGE plpgsql
IMMUTABLE SET lock_timeout = '100ms' AS $$
DECLARE
  v_parsed jsonb;
BEGIN
  IF jsonb_typeof(p_output) = 'object' THEN
    RETURN p_output;
  END IF;
  IF jsonb_typeof(p_output) IS DISTINCT FROM 'string'
    OR NOT pg_input_is_valid(p_output #>> '{}', 'jsonb') THEN
    RETURN NULL;
  END IF;
  v_parsed := (p_output #>> '{}')::jsonb;
  IF jsonb_typeof(v_parsed) = 'object' THEN
    RETURN v_parsed;
  END IF;
  RETURN NULL;
END;
$$;

-- 0013's mc.record_step_attempt, unchanged but for reading a string-held object.
CREATE OR REPLACE FUNCTION mc.record_step_attempt(
  p_event_id uuid,
  p_run_id uuid,
  p_event_type text,
  p_step text,
  p_data jsonb
) RETURNS void LANGUAGE plpgsql
SET lock_timeout = '100ms' AS $$
DECLARE
  v_raw jsonb;
  v_output jsonb;
BEGIN
  IF EXISTS (SELECT 1 FROM public.remote_agent_workflow_runs
    WHERE id = p_run_id AND workflow_name <> 'archon-loop') THEN
    RETURN;
  END IF;
  v_raw := mc.structured_output(p_data -> 'structured_output');
  v_output := mc.step_output(p_step, v_raw);
  INSERT INTO mc.lap_step_attempts AS a (run_id, step_id, event_id, started_at, status,
    duration_ms, cost_usd, route, outcome, reason, holdout_catches)
  VALUES (
    p_run_id,
    p_step,
    p_event_id,
    coalesce((p_data -> 'timing' ->> 'startedAt')::timestamptz, '-infinity'),
    substring(p_event_type FROM 6),
    coalesce(p_data ->> 'duration_ms', p_data -> 'timing' ->> 'durationMs')::bigint,
    (p_data ->> 'cost_usd')::numeric,
    v_output ->> 'route',
    v_output ->> 'outcome',
    v_output ->> 'reason',
    CASE WHEN p_event_type = 'node_completed' AND p_step = 'check-app'
      THEN mc.holdout_catches(v_raw -> 'lines') ELSE 0 END)
  ON CONFLICT (run_id, step_id, event_id) DO UPDATE SET
    started_at = EXCLUDED.started_at,
    status = EXCLUDED.status,
    duration_ms = EXCLUDED.duration_ms,
    cost_usd = EXCLUDED.cost_usd,
    route = EXCLUDED.route,
    outcome = EXCLUDED.outcome,
    reason = EXCLUDED.reason,
    holdout_catches = EXCLUDED.holdout_catches;
END;
$$;

-- 0015's mc.project_step_event, unchanged but for reading a string-held object.
CREATE OR REPLACE FUNCTION mc.project_step_event() RETURNS trigger LANGUAGE plpgsql
SET lock_timeout = '100ms' AS $$
DECLARE
  v_raw jsonb;
  v_parsed jsonb;
  v_output jsonb;
  v_started timestamptz;
  v_duration bigint;
  v_model text;
BEGIN
  IF EXISTS (SELECT 1 FROM public.remote_agent_workflow_runs
    WHERE id = NEW.workflow_run_id AND workflow_name <> 'archon-loop') THEN
    RETURN NULL;
  END IF;
  v_raw := NEW.data -> 'structured_output';
  v_parsed := mc.structured_output(v_raw);
  IF jsonb_typeof(v_raw) NOT IN ('object', 'null') AND v_parsed IS NULL THEN
    PERFORM mc.record_projection_error(TG_NAME, NEW.workflow_run_id, NEW.id, '22000',
      format('structured_output is a jsonb %s, not an object', jsonb_typeof(v_raw)));
  END IF;
  v_output := mc.step_output(NEW.step_name, v_parsed);
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
  END IF;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  PERFORM mc.record_projection_error(TG_NAME, NEW.workflow_run_id, NEW.id, SQLSTATE, SQLERRM);
  RETURN NULL;
END;
$$;
