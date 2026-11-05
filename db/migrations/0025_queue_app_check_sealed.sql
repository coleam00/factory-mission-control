-- A queue factory's app check shows only the result the factory sealed (issue #437). 0024 kept the
-- `check` step's own report: its overall, and its lines under a rule looser than the factory's. But
-- the factory publishes something else. Its `evidence` step re-validates the result against
-- evidence.ts `LINE` and throws on any problem, and `publish` posts `evidence`'s overall and lines.
-- So a result the factory refused still showed a verdict on the home map's failing chip, the
-- Board's chip and the App check panel, with lines the factory would never post.
--
-- Now a verdict and lines exist only once `evidence` completed. The `check` row keeps no output
-- when `check` completes and the run's lines are cleared; `evidence` completing writes its overall
-- onto the `check` row, with the pull request and head the run's `select` row kept, and stores its
-- lines. A run whose `evidence` failed or has not completed shows no verdict and no lines, so the
-- readers fall back to the pull request's previous sealed verdict, as they do for a failed check.
-- The readers are unchanged: they already read `overall` and `pr` off the `check` row.
--
-- A line is stored only when it matches `LINE` in full, evidence tail included, on the untrimmed
-- line. The sentence is never stored (MISSION rule 3): id, kind, verdict and whether it cites
-- evidence. A run with a holdout line, at `check` or at `evidence`, keeps no output and no lines.
--
-- Only mc.project_step_event and the functions it calls change; like 0020's it cannot raise inside
-- Archon's write (0006's invariant 1). Runs finished before this file are re-derived at the end of
-- it under the same rule, and `reconcile:laps` replays the rest. Run again, it changes nothing.


-- Mirrors the factory's evidence.ts LINE, untrimmed; the p flag makes . stop at a newline as it does there.
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
    SELECT regexp_match(l.line #>> '{}',
      '^([CPA][0-9]+)\s{2}(PASS|FAIL|INCOMPLETE)\s{2}(.+?)\s{2}evidence:\s+(.+)$', 'p') AS parts
  ) m
  WHERE jsonb_typeof(l.line) = 'string' AND m.parts IS NOT NULL
$$;

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
  END
$$;

CREATE OR REPLACE FUNCTION mc.project_queue_app_check(p_run_id uuid, p_step text, p_output jsonb)
RETURNS void LANGUAGE plpgsql
SET lock_timeout = '100ms' AS $fn$
DECLARE
  v_verdict jsonb;
BEGIN
  IF p_step = 'check' THEN
    UPDATE mc.lap_steps SET output = NULL WHERE run_id = p_run_id AND step_id = 'check';
    PERFORM mc.project_app_check_lines(p_run_id, '[]'::jsonb);
    IF mc.queue_app_check_has_holdout(p_output -> 'lines') THEN
      UPDATE mc.lap_steps SET output = NULL WHERE run_id = p_run_id AND step_id = 'select';
    END IF;
  ELSIF p_step = 'evidence' THEN
    IF mc.queue_app_check_has_holdout(p_output -> 'lines') THEN
      UPDATE mc.lap_steps SET output = NULL WHERE run_id = p_run_id AND step_id = 'select';
      RETURN;
    END IF;
    IF jsonb_typeof(p_output) = 'object' AND p_output ->> 'overall' IN ('PASS', 'FAIL') THEN
      v_verdict := jsonb_build_object('overall', p_output -> 'overall')
        || (SELECT s.output FROM mc.lap_steps s WHERE s.run_id = p_run_id AND s.step_id = 'select');
    END IF;
    IF v_verdict IS NOT NULL THEN
      UPDATE mc.lap_steps SET output = v_verdict WHERE run_id = p_run_id AND step_id = 'check';
      PERFORM mc.project_app_check_lines(p_run_id, mc.queue_app_check_lines(p_output -> 'lines'));
    END IF;
  END IF;
END;
$fn$;

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
    IF NEW.event_type = 'node_completed' AND v_workflow = 'factory-app-check'
      AND NEW.step_name IN ('check', 'evidence') THEN
      BEGIN
        PERFORM mc.project_queue_app_check(NEW.workflow_run_id, NEW.step_name, v_parsed);
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


DO $backfill$
DECLARE
  e record;
BEGIN
  UPDATE mc.lap_steps s SET output = NULL
  FROM public.remote_agent_workflow_runs r
  WHERE r.id = s.run_id AND r.workflow_name = 'factory-app-check' AND s.step_id = 'check'
    AND s.output IS NOT NULL;
  DELETE FROM mc.app_check_lines a
  USING public.remote_agent_workflow_runs r
  WHERE r.id = a.run_id AND r.workflow_name = 'factory-app-check';
  FOR e IN
    SELECT ev.workflow_run_id AS run_id, ev.step_name, ev.data
    FROM public.remote_agent_workflow_events ev
    JOIN public.remote_agent_workflow_runs r ON r.id = ev.workflow_run_id
    WHERE r.workflow_name = 'factory-app-check' AND ev.event_type = 'node_completed'
      AND ev.step_name IN ('check', 'evidence')
      AND EXISTS (SELECT 1 FROM mc.lap_steps s
        WHERE s.run_id = ev.workflow_run_id AND s.step_id = 'check')
    ORDER BY ev.created_at, coalesce(ev.event_order, 0), ev.id
  LOOP
    PERFORM mc.project_queue_app_check(e.run_id, e.step_name,
      mc.structured_output(e.data -> 'structured_output'));
  END LOOP;
END
$backfill$;
