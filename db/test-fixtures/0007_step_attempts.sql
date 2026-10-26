-- Frozen pre-eligibility migration from 16a87bff, used to exercise installed-database upgrades.
-- One row per finished attempt of a lap's step (PRD 4.2, 11.4). mc.lap_steps keeps one row per
-- (run, step), so a step that runs again in the same run overwrites what its earlier attempt
-- recorded; the scorecard counts every attempt: a review that sent back before it approved, the
-- cost of every attempt, every check-app run's duration and its holdout catches.
--
-- An attempt is keyed by its run, its step and when it started on Archon's clock
-- (`timing.startedAt`), so a replayed event updates its row and a retry adds one; an event with no
-- start time is the step's one attempt with none (`-infinity`), as mc.lap_steps would keep it. An
-- attempt belongs to its step's mc.lap_steps row and goes with it.
--
-- Invariant 1 as in 0006_projection.sql: mc.project_step_event records the attempt after the step
-- row, in its own exception block, so a failure loses the attempt alone and is recorded in
-- mc.projection_errors, and an event still waits on at most one lock, for at most 100 ms.

CREATE TABLE IF NOT EXISTS mc.lap_step_attempts (
  run_id uuid NOT NULL,
  step_id text NOT NULL,
  started_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('completed', 'failed', 'skipped')),
  duration_ms bigint,
  cost_usd numeric,
  -- The fields of the step's kept output (mc.step_output) the scorecard reads.
  route text,
  outcome text,
  reason text,
  -- A check-app attempt's lines of kind holdout, verdict FAIL and empty pre_existing, counted the
  -- way mc.project_app_check_lines stores them; never their text.
  holdout_catches integer NOT NULL DEFAULT 0,
  PRIMARY KEY (run_id, step_id, started_at),
  FOREIGN KEY (run_id, step_id) REFERENCES mc.lap_steps (run_id, step_id) ON DELETE CASCADE
);

-- A check-app report's new holdout catches. Lines that are not an array count none.
CREATE OR REPLACE FUNCTION mc.holdout_catches(p_lines jsonb)
RETURNS integer LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN jsonb_typeof(p_lines) = 'array' THEN (
    SELECT count(*)::int FROM jsonb_array_elements(p_lines) AS l(line)
    WHERE coalesce(nullif(mc.gate_trim(l.line ->> 'kind'), ''), 'defect') = 'holdout'
      AND upper(mc.gate_trim(coalesce(l.line ->> 'verdict', ''))) = 'FAIL'
      AND mc.gate_trim(coalesce(l.line ->> 'pre_existing', '')) = '')
  ELSE 0 END
$$;

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

-- 0006's mc.project_step_event, unchanged but for recording the attempt a finishing event ends.
CREATE OR REPLACE FUNCTION mc.project_step_event() RETURNS trigger LANGUAGE plpgsql
SET lock_timeout = '100ms' AS $$
DECLARE
  v_output jsonb;
  v_started timestamptz;
  v_duration bigint;
  v_model text;
BEGIN
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

-- The attempts Archon finished before this migration, in Archon's order, each in its own
-- exception block like the trigger, so one bad event is recorded and skipped rather than failing
-- the migration. Replaying an event already recorded rewrites its row with the same values.
DO $$
DECLARE
  e record;
BEGIN
  FOR e IN
    SELECT ev.id, ev.workflow_run_id, ev.event_type, ev.step_name, ev.data
    FROM public.remote_agent_workflow_events ev
    WHERE ev.event_type IN ('node_completed', 'node_failed', 'node_skipped')
    ORDER BY ev.created_at, coalesce(ev.event_order, 0), ev.id
  LOOP
    BEGIN
      PERFORM mc.record_step_attempt(e.workflow_run_id, e.event_type, e.step_name, e.data);
    EXCEPTION WHEN OTHERS THEN
      PERFORM mc.record_projection_error('0007_step_attempts', e.workflow_run_id, e.id, SQLSTATE,
        SQLERRM);
    END;
  END LOOP;
END;
$$;
