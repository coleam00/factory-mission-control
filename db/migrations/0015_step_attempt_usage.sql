-- Each attempt of a step keeps the model and tokens Archon recorded for it (issue #201). 0007
-- left them on the step row, which holds only a step's latest run, so a lap's page read `none`
-- for every earlier attempt of a repeated step. They live in their own table, keyed by the event
-- that finished the attempt as mc.lap_step_attempts is since 0013, so nothing that rebuilds the
-- attempts (0013 run again, `reconcile:laps`) loses them, and a replay writes the same row.
--
-- A finishing event names its model when Archon resolved one; otherwise the attempt ran on the
-- model its own node_started event named, the latest start of that step in the run at or before
-- the finish, as mc.lap_steps carries it. Only laps' events are projected (0010).
--
-- Run again, it changes nothing: the table and function are created if missing and the backfill
-- writes each finished event's row as the trigger would.

CREATE TABLE IF NOT EXISTS mc.lap_step_attempt_usage (
  event_id uuid PRIMARY KEY,
  run_id uuid NOT NULL,
  step_id text NOT NULL,
  model text,
  tokens_input bigint,
  tokens_output bigint,
  tokens_cache_read bigint,
  tokens_cache_write bigint
);
CREATE INDEX IF NOT EXISTS lap_step_attempt_usage_run ON mc.lap_step_attempt_usage (run_id);

CREATE OR REPLACE FUNCTION mc.record_attempt_usage(
  p_event_id uuid,
  p_run_id uuid,
  p_step text,
  p_at timestamptz,
  p_data jsonb
) RETURNS void LANGUAGE plpgsql
SET lock_timeout = '100ms' AS $$
DECLARE
  v_model text;
BEGIN
  IF EXISTS (SELECT 1 FROM public.remote_agent_workflow_runs
    WHERE id = p_run_id AND workflow_name <> 'archon-loop') THEN
    RETURN;
  END IF;
  v_model := coalesce(p_data -> 'model_usage' ->> 'resolved', p_data ->> 'model');
  IF v_model IS NULL THEN
    SELECT coalesce(s.data -> 'model_usage' ->> 'resolved', s.data ->> 'model') INTO v_model
    FROM public.remote_agent_workflow_events s
    WHERE s.workflow_run_id = p_run_id AND s.step_name = p_step
      AND s.event_type = 'node_started' AND s.created_at <= p_at
    ORDER BY s.created_at DESC, coalesce(s.event_order, 0) DESC, s.id DESC
    LIMIT 1;
  END IF;
  INSERT INTO mc.lap_step_attempt_usage AS u (event_id, run_id, step_id, model, tokens_input,
    tokens_output, tokens_cache_read, tokens_cache_write)
  VALUES (
    p_event_id,
    p_run_id,
    p_step,
    v_model,
    (p_data -> 'tokens' ->> 'input')::bigint,
    (p_data -> 'tokens' ->> 'output')::bigint,
    (p_data -> 'tokens' ->> 'cacheRead')::bigint,
    (p_data -> 'tokens' ->> 'cacheWrite')::bigint)
  ON CONFLICT (event_id) DO UPDATE SET
    run_id = EXCLUDED.run_id,
    step_id = EXCLUDED.step_id,
    model = EXCLUDED.model,
    tokens_input = EXCLUDED.tokens_input,
    tokens_output = EXCLUDED.tokens_output,
    tokens_cache_read = EXCLUDED.tokens_cache_read,
    tokens_cache_write = EXCLUDED.tokens_cache_write;
END;
$$;

-- 0013's mc.project_step_event, unchanged but for recording each finishing event's usage.
CREATE OR REPLACE FUNCTION mc.project_step_event() RETURNS trigger LANGUAGE plpgsql
SET lock_timeout = '100ms' AS $$
DECLARE
  v_output jsonb;
  v_started timestamptz;
  v_duration bigint;
  v_model text;
BEGIN
  IF EXISTS (SELECT 1 FROM public.remote_agent_workflow_runs
    WHERE id = NEW.workflow_run_id AND workflow_name <> 'archon-loop') THEN
    RETURN NULL;
  END IF;
  v_output := NEW.data -> 'structured_output';
  IF jsonb_typeof(v_output) NOT IN ('object', 'null') THEN
    PERFORM mc.record_projection_error(TG_NAME, NEW.workflow_run_id, NEW.id, '22000',
      format('structured_output is a jsonb %s, not an object', jsonb_typeof(v_output)));
  END IF;
  IF jsonb_typeof(v_output) IS DISTINCT FROM 'object' THEN
    v_output := NULL;
  END IF;
  v_output := mc.step_output(NEW.step_name, v_output);
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
      AND NEW.data -> 'structured_output' ? 'lines' THEN
      BEGIN
        PERFORM mc.project_app_check_lines(NEW.workflow_run_id,
          NEW.data -> 'structured_output' -> 'lines');
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

DO $$
DECLARE
  e record;
  v_sqlstate text;
  v_message text;
BEGIN
  FOR e IN
    SELECT ev.id, ev.workflow_run_id, ev.step_name, ev.created_at, ev.data
    FROM public.remote_agent_workflow_events ev
    JOIN public.remote_agent_workflow_runs r ON r.id = ev.workflow_run_id
    JOIN mc.lap_steps s ON s.run_id = ev.workflow_run_id AND s.step_id = ev.step_name
    WHERE r.workflow_name = 'archon-loop'
      AND ev.event_type IN ('node_completed', 'node_failed', 'node_skipped')
    ORDER BY ev.created_at, coalesce(ev.event_order, 0), ev.id
  LOOP
    BEGIN
      PERFORM mc.record_attempt_usage(e.id, e.workflow_run_id, e.step_name, e.created_at, e.data);
    EXCEPTION WHEN OTHERS THEN
      v_sqlstate := SQLSTATE;
      v_message := SQLERRM;
      IF NOT EXISTS (SELECT 1 FROM mc.projection_errors p
        WHERE p.event_id = e.id AND p.sqlstate = v_sqlstate AND p.message = v_message) THEN
        PERFORM mc.record_projection_error('0015_step_attempt_usage', e.workflow_run_id, e.id,
          v_sqlstate, v_message);
      END IF;
    END;
  END LOOP;
END;
$$;
