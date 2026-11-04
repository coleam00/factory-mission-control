-- A queue run's step events and attempts reach the map (issue #333). 0010 let only an `archon-loop`
-- run's events project steps and attempts, so a real node_started on a running `archon-build-queue`
-- run never wrote the step row the map's Build and Review chips count, and a completed
-- `archon-merge-queue` run's `record` step never wrote the output Shipped's merged chip reads.
-- The workflows below are the ones the map's queue cards cover; a manager, holdouts or backlog run
-- of the old pack (`archon-manager`, `archon-holdouts`, `archon-backlog`) still records nothing,
-- as 0010 meant.
--
-- 0013's mc.record_step_attempt, 0015's mc.record_attempt_usage and mc.project_step_event are
-- unchanged but for that one condition, plus the mc.keeps_step_output redaction in
-- record_step_attempt and project_step_event. The new functions only compare a name, so like them
-- they cannot raise inside Archon's write (0006's invariant 1); the trigger's own handler is unchanged.
-- Runs finished before this file get no steps from it: `reconcile:laps` replays them through these
-- functions. Run again, it changes nothing.
--
-- The holdout workflows (`factory-holdouts`, `factory-app-check`, `factory-holdout-sweep`) take
-- holdout scenarios as input, and mc.step_output only knows the old loop's `check-app` and
-- `review` steps. Their steps keep status and timing but no output, no route, outcome or reason
-- (MISSION rule 3: never store a holdout scenario's text).

CREATE OR REPLACE FUNCTION mc.projects_step_events(p_workflow text)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(p_workflow IN ('archon-loop', 'archon-intake', 'archon-build-queue',
    'archon-merge-queue', 'archon-discoveries', 'factory-app-check', 'factory-backlog',
    'factory-deploy', 'factory-holdout-sweep', 'factory-holdouts', 'factory-manager'), false)
$$;

CREATE OR REPLACE FUNCTION mc.keeps_step_output(p_workflow text)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT p_workflow IS NULL
    OR p_workflow NOT IN ('factory-holdouts', 'factory-app-check', 'factory-holdout-sweep')
$$;

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
    WHERE id = p_run_id AND NOT mc.projects_step_events(workflow_name)) THEN
    RETURN;
  END IF;
  v_raw := p_data -> 'structured_output';
  IF jsonb_typeof(v_raw) IS DISTINCT FROM 'object' THEN
    v_raw := NULL;
  END IF;
  v_output := mc.step_output(p_step, v_raw);
  IF NOT mc.keeps_step_output((SELECT workflow_name FROM public.remote_agent_workflow_runs
    WHERE id = p_run_id)) THEN
    v_output := NULL;
  END IF;
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
    WHERE id = p_run_id AND NOT mc.projects_step_events(workflow_name)) THEN
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

CREATE OR REPLACE FUNCTION mc.project_step_event() RETURNS trigger LANGUAGE plpgsql
SET lock_timeout = '100ms' AS $$
DECLARE
  v_output jsonb;
  v_started timestamptz;
  v_duration bigint;
  v_model text;
BEGIN
  IF EXISTS (SELECT 1 FROM public.remote_agent_workflow_runs
    WHERE id = NEW.workflow_run_id AND NOT mc.projects_step_events(workflow_name)) THEN
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
  IF NOT mc.keeps_step_output((SELECT workflow_name FROM public.remote_agent_workflow_runs
    WHERE id = NEW.workflow_run_id)) THEN
    v_output := NULL;
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
