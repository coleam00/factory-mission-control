-- An attempt is the event that finished it (issue #175). 0007 keyed an attempt by its run, its step
-- and `timing.startedAt`, so two runs of one step in a lap whose finishing events carry the same
-- start time, or none (`-infinity`), were one row: the later overwrote the earlier, and the
-- scorecard lost a review's send-back and the earlier run's cost and duration. Each finishing
-- event's id is Archon's own and unique, and `reconcile:laps` replays a run's events with their
-- ids, so a replayed event still updates its row and every other finished run of a step adds one.
--
-- 0007 and 0010 are applied on main and never re-run, so the change is here. The attempts are
-- rebuilt from Archon's events, as 0007 built them: a run of a step those keys merged gets its row
-- back. Only laps' events are replayed (0010), and only those whose step row exists, as the trigger
-- writes the step row first. The attempts 0007 recorded for runs that are not laps are not
-- rebuilt; `reconcile:laps` already removes them. A replay error is recorded unless the same error
-- of the same event already is, so this file can run again without adding any.

ALTER TABLE mc.lap_step_attempts ADD COLUMN IF NOT EXISTS event_id uuid;
DELETE FROM mc.lap_step_attempts;
ALTER TABLE mc.lap_step_attempts ALTER COLUMN event_id SET NOT NULL;
ALTER TABLE mc.lap_step_attempts DROP CONSTRAINT IF EXISTS lap_step_attempts_pkey;
ALTER TABLE mc.lap_step_attempts ADD PRIMARY KEY (run_id, step_id, event_id);

DROP FUNCTION IF EXISTS mc.record_step_attempt(uuid, text, text, jsonb);

-- Upserts the attempt the node_completed, node_failed or node_skipped event `p_event_id` finished.
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
  v_raw := p_data -> 'structured_output';
  IF jsonb_typeof(v_raw) IS DISTINCT FROM 'object' THEN
    v_raw := NULL;
  END IF;
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

-- 0010's mc.project_step_event, unchanged but for passing the finishing event's id.
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
    SELECT ev.id, ev.workflow_run_id, ev.event_type, ev.step_name, ev.data
    FROM public.remote_agent_workflow_events ev
    JOIN public.remote_agent_workflow_runs r ON r.id = ev.workflow_run_id
    JOIN mc.lap_steps s ON s.run_id = ev.workflow_run_id AND s.step_id = ev.step_name
    WHERE r.workflow_name = 'archon-loop'
      AND ev.event_type IN ('node_completed', 'node_failed', 'node_skipped')
    ORDER BY ev.created_at, coalesce(ev.event_order, 0), ev.id
  LOOP
    BEGIN
      PERFORM mc.record_step_attempt(e.id, e.workflow_run_id, e.event_type, e.step_name, e.data);
    EXCEPTION WHEN OTHERS THEN
      v_sqlstate := SQLSTATE;
      v_message := SQLERRM;
      IF NOT EXISTS (SELECT 1 FROM mc.projection_errors p
        WHERE p.event_id = e.id AND p.sqlstate = v_sqlstate AND p.message = v_message) THEN
        PERFORM mc.record_projection_error('0013_step_attempt_identity', e.workflow_run_id, e.id,
          v_sqlstate, v_message);
      END IF;
    END;
  END LOOP;
END;
$$;
