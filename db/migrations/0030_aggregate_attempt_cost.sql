-- A loop's roll-up no longer counts twice in a run's cost (issue #484). Archon completes a loop node
-- (`ship__deliver__rounds`) with a cost_usd that is the sum of its rounds' nodes, flagged
-- `aggregate: true`, and mc.lap_step_attempts held it beside those nodes, so every per-run sum of
-- attempts (lanes, recent-laps, work-item, the scorecard) counted the loop twice.
--
-- The projection owns the fact: an aggregate event's attempt row keeps no cost, so every sum over
-- mc.lap_step_attempts follows without restating the rule. mc.lap_steps still holds the roll-up
-- figure for the loop row's own panel. Only mc.record_step_attempt changes (0020's body, plus that
-- CASE); `reconcile:laps` replays the same function, and the UPDATE below repairs rows projected
-- before this file. Run again, it changes nothing.

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
  v_raw := mc.structured_output(p_data -> 'structured_output');
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
    CASE WHEN p_data -> 'aggregate' = 'true'::jsonb THEN NULL ELSE (p_data ->> 'cost_usd')::numeric END,
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

UPDATE mc.lap_step_attempts a SET cost_usd = NULL
FROM public.remote_agent_workflow_events e
WHERE e.id = a.event_id AND e.data -> 'aggregate' = 'true'::jsonb AND a.cost_usd IS NOT NULL;
