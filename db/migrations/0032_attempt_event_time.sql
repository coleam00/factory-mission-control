-- A skipped step's attempt has no start (Archon's skip event carries no timing), so the run page
-- could not tell which loop round it was skipped in (#518). The attempt now keeps when the event
-- that finished it arrived. Only mc.record_step_attempt changes (0030's body, plus event_at);
-- `reconcile:laps` replays the same function, and the UPDATE below fills the rows projected before
-- this file. Run again, it changes nothing.

ALTER TABLE mc.lap_step_attempts ADD COLUMN IF NOT EXISTS event_at timestamptz;

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
    duration_ms, cost_usd, route, outcome, reason, holdout_catches, event_at)
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
      THEN mc.holdout_catches(v_raw -> 'lines') ELSE 0 END,
    (SELECT created_at FROM public.remote_agent_workflow_events WHERE id = p_event_id))
  ON CONFLICT (run_id, step_id, event_id) DO UPDATE SET
    started_at = EXCLUDED.started_at,
    status = EXCLUDED.status,
    duration_ms = EXCLUDED.duration_ms,
    cost_usd = EXCLUDED.cost_usd,
    route = EXCLUDED.route,
    outcome = EXCLUDED.outcome,
    reason = EXCLUDED.reason,
    holdout_catches = EXCLUDED.holdout_catches,
    event_at = EXCLUDED.event_at;
END;
$$;

UPDATE mc.lap_step_attempts a SET event_at = e.created_at
FROM public.remote_agent_workflow_events e
WHERE e.id = a.event_id AND a.event_at IS NULL;
