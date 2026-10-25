-- The Archon projection (PRD 11.4): triggers on Archon's runs and step-level events upsert
-- mc.laps, mc.lap_steps and mc.app_check_lines. They read Archon's rows and write only to mc.
--
-- Invariant 1: an Archon write never fails or waits because of these. Every trigger body runs in
-- its own exception block, so a failed projection rolls back alone and is recorded in
-- mc.projection_errors; when even that insert fails, the error is dropped rather than raised.
-- Every function that takes a lock on an mc table sets lock_timeout, so a lock another session
-- holds there (a migration's ALTER TABLE, an uncommitted write of the same row) stops a wait after
-- 100 ms with lock_not_available, which the exception blocks catch, instead of holding Archon's
-- write until the lock is released or Archon's own statement_timeout cancels it (query_canceled,
-- which WHEN OTHERS does not catch).

CREATE OR REPLACE FUNCTION mc.record_projection_error(
  p_source text,
  p_run_id uuid,
  p_event_id uuid,
  p_sqlstate text,
  p_message text
) RETURNS void LANGUAGE plpgsql
SET lock_timeout = '100ms' AS $$
BEGIN
  INSERT INTO mc.projection_errors (source, run_id, event_id, sqlstate, message)
  VALUES (p_source, p_run_id, p_event_id, p_sqlstate, p_message);
EXCEPTION WHEN OTHERS THEN
  NULL;
END;
$$;

-- A string field trimmed the way the merge gate's str() trims it with JS trim(), on ASCII.
CREATE OR REPLACE FUNCTION mc.gate_trim(p_value text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT btrim(p_value, E' \t\n\r\f\x0B')
$$;

-- A check-app report's lines, by 1-based position, without their text: a holdout line keeps only
-- the first H-<nn> in its text, or `unidentified` (PRD 6.3, 11.7), matched as parsers/metrics.ts
-- holdoutId matches /\bH-\d{2,}\b/. An empty kind reads as a defect, as the merge gate's
-- readAppCheck reads it.
CREATE OR REPLACE FUNCTION mc.project_app_check_lines(p_run_id uuid, p_lines jsonb)
RETURNS void LANGUAGE plpgsql
SET lock_timeout = '100ms' AS $$
BEGIN
  INSERT INTO mc.app_check_lines AS a
    (run_id, position, kind, verdict, evidence_count, pre_existing, scenario_id)
  SELECT
    p_run_id,
    l.position,
    k.kind,
    upper(mc.gate_trim(coalesce(l.line ->> 'verdict', ''))),
    CASE WHEN jsonb_typeof(l.line -> 'evidence') = 'array'
      THEN jsonb_array_length(l.line -> 'evidence') ELSE 0 END,
    mc.gate_trim(coalesce(l.line ->> 'pre_existing', '')),
    CASE WHEN k.kind = 'holdout'
      THEN coalesce(
        substring(l.line ->> 'text' FROM '(?<![A-Za-z0-9_])H-[0-9]{2,}(?![A-Za-z0-9_])'),
        'unidentified') END
  FROM jsonb_array_elements(p_lines) WITH ORDINALITY AS l(line, position)
  CROSS JOIN LATERAL (SELECT coalesce(nullif(mc.gate_trim(l.line ->> 'kind'), ''), 'defect') AS kind) k
  ON CONFLICT (run_id, position) DO UPDATE SET
    kind = EXCLUDED.kind,
    verdict = EXCLUDED.verdict,
    evidence_count = EXCLUDED.evidence_count,
    pre_existing = EXCLUDED.pre_existing,
    scenario_id = EXCLUDED.scenario_id;
  DELETE FROM mc.app_check_lines
  WHERE run_id = p_run_id AND position > jsonb_array_length(p_lines);
END;
$$;

-- What a step's output keeps in mc.lap_steps. The check-app and review steps read holdout
-- results, so their free text can quote a holdout line: they keep only their outcome fields, and
-- a review disposition only its action and the line's leading id (as the merge gate's
-- parseDispositions reads it). Any other step keeps its output without `lines`.
CREATE OR REPLACE FUNCTION mc.step_output(p_step text, p_output jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_step
    WHEN 'check-app' THEN (SELECT jsonb_object_agg(key, value) FROM jsonb_each(p_output)
      WHERE key IN ('pr', 'head', 'merged_with', 'overall'))
    WHEN 'review' THEN (SELECT jsonb_object_agg(key, CASE
        WHEN key <> 'dispositions' THEN value
        WHEN jsonb_typeof(value) = 'array' THEN (
          SELECT coalesce(jsonb_agg(jsonb_build_object(
              'line', upper(substring(mc.gate_trim(d.entry ->> 'line') FROM '^[A-Za-z]+[0-9]+')),
              'action', d.entry -> 'action') ORDER BY d.n), '[]')
          FROM jsonb_array_elements(value) WITH ORDINALITY AS d(entry, n))
        END)
      FROM jsonb_each(p_output)
      WHERE key IN ('outcome', 'pr', 'sha', 'delivers', 'dispositions'))
    ELSE p_output - 'lines'
  END
$$;

-- One step row per (run, step_name). A step finishes at its start plus its duration, both on
-- Archon's clock, or else when the event was written. A node_started resets the row only while
-- it is running or when it starts after the row's last attempt finished (a retry), so a replayed
-- start never reopens a finished step. A check-app report whose lines cannot be projected keeps
-- its step row; the lines' error is recorded on its own.
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
    RAISE EXCEPTION 'structured_output is a jsonb %, not an object', jsonb_typeof(v_output)
      USING ERRCODE = 'data_exception';
  END IF;
  IF jsonb_typeof(v_output) = 'null' THEN
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

-- A lap's factory is the one whose codebase is the run's; a run of a codebase no factory names
-- keeps its codebase's name, and a run with no codebase an empty one.
CREATE OR REPLACE FUNCTION mc.project_run() RETURNS trigger LANGUAGE plpgsql
SET lock_timeout = '100ms' AS $$
DECLARE
  v_codebase text;
BEGIN
  v_codebase := (SELECT c.name FROM public.remote_agent_codebases c WHERE c.id = NEW.codebase_id);
  INSERT INTO mc.laps AS l
    (run_id, factory, workflow_name, status, digest, started_at, completed_at)
  VALUES (
    NEW.id,
    coalesce(
      (SELECT f.name FROM mc.factories f WHERE f.codebase = v_codebase ORDER BY f.name LIMIT 1),
      v_codebase,
      ''),
    NEW.workflow_name,
    NEW.status,
    NEW.metadata -> 'workflow_source' ->> 'digest',
    NEW.started_at,
    NEW.completed_at)
  ON CONFLICT (run_id) DO UPDATE SET
    factory = EXCLUDED.factory,
    workflow_name = EXCLUDED.workflow_name,
    status = EXCLUDED.status,
    digest = EXCLUDED.digest,
    started_at = EXCLUDED.started_at,
    completed_at = EXCLUDED.completed_at;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  PERFORM mc.record_projection_error(TG_NAME, NEW.id, NULL, SQLSTATE, SQLERRM);
  RETURN NULL;
END;
$$;

-- Only the four step-level event types: provider_event rows (about 30 a step) never fire it.
CREATE OR REPLACE TRIGGER mc_project_step_event
  AFTER INSERT ON public.remote_agent_workflow_events
  FOR EACH ROW
  WHEN (NEW.event_type IN ('node_started', 'node_completed', 'node_failed', 'node_skipped'))
  EXECUTE FUNCTION mc.project_step_event();

CREATE OR REPLACE TRIGGER mc_project_run_insert
  AFTER INSERT ON public.remote_agent_workflow_runs
  FOR EACH ROW
  EXECUTE FUNCTION mc.project_run();

-- Archon touches a running run's last_activity_at often; only a change a lap shows fires this.
CREATE OR REPLACE TRIGGER mc_project_run_update
  AFTER UPDATE ON public.remote_agent_workflow_runs
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status
    OR OLD.workflow_name IS DISTINCT FROM NEW.workflow_name
    OR OLD.codebase_id IS DISTINCT FROM NEW.codebase_id
    OR OLD.started_at IS DISTINCT FROM NEW.started_at
    OR OLD.completed_at IS DISTINCT FROM NEW.completed_at
    OR OLD.metadata -> 'workflow_source' ->> 'digest'
      IS DISTINCT FROM NEW.metadata -> 'workflow_source' ->> 'digest')
  EXECUTE FUNCTION mc.project_run();
