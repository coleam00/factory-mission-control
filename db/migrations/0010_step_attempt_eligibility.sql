-- Only a lap's events project steps and attempts (issue #111; a lap is an `archon-loop` run, PRD
-- 4.2). 0007's mc.record_step_attempt and mc.project_step_event projected every run's step events,
-- so a manager, holdouts or backlog run's node added a step and an attempt, and 0007's replay of
-- the attempts Archon finished before it recorded a foreign-key error for each such node whose run
-- had no step row. Both functions now return before reading anything from a run that is not a lap,
-- whose events record nothing and no error. A real failure of an eligible lap's attempt is still
-- caught and recorded as before.
--
-- 0007 is applied on main and never re-run, so the change is here, not there. Nothing is replayed
-- and no step or attempt is removed; the one thing undone is the false errors 0007's replay
-- recorded for runs that are not laps, which the corrected replay would never have recorded.

-- Upserts the attempt a node_completed, node_failed or node_skipped event finished.
CREATE OR REPLACE FUNCTION mc.record_step_attempt(
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
  v_raw := p_data -> 'structured_output';
  IF jsonb_typeof(v_raw) IS DISTINCT FROM 'object' THEN
    v_raw := NULL;
  END IF;
  v_output := mc.step_output(p_step, v_raw);
  INSERT INTO mc.lap_step_attempts AS a (run_id, step_id, started_at, status, duration_ms,
    cost_usd, route, outcome, reason, holdout_catches)
  VALUES (
    p_run_id,
    p_step,
    coalesce((p_data -> 'timing' ->> 'startedAt')::timestamptz, '-infinity'),
    substring(p_event_type FROM 6),
    coalesce(p_data ->> 'duration_ms', p_data -> 'timing' ->> 'durationMs')::bigint,
    (p_data ->> 'cost_usd')::numeric,
    v_output ->> 'route',
    v_output ->> 'outcome',
    v_output ->> 'reason',
    CASE WHEN p_event_type = 'node_completed' AND p_step = 'check-app'
      THEN mc.holdout_catches(v_raw -> 'lines') ELSE 0 END)
  ON CONFLICT (run_id, step_id, started_at) DO UPDATE SET
    status = EXCLUDED.status,
    duration_ms = EXCLUDED.duration_ms,
    cost_usd = EXCLUDED.cost_usd,
    route = EXCLUDED.route,
    outcome = EXCLUDED.outcome,
    reason = EXCLUDED.reason,
    holdout_catches = EXCLUDED.holdout_catches;
END;
$$;

-- Only lap events project steps and their finished attempts.
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
      PERFORM mc.record_step_attempt(NEW.workflow_run_id, NEW.event_type, NEW.step_name, NEW.data);
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

DELETE FROM mc.projection_errors p
USING public.remote_agent_workflow_runs r
WHERE p.source = '0007_step_attempts' AND r.id = p.run_id AND r.workflow_name <> 'archon-loop';
