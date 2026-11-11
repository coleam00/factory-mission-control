-- Archon's SDLC metric records (issue #630). Archon keeps none of them in a table of their own: each is
-- an element of the `structured_output.metrics` array of a `node_completed` event. A live query may not
-- read Archon's tables or expand a JSON array (db/queries/REALTIME.md), so the records are projected
-- here, verbatim, one row per record, as every other Archon fact is.
-- This applies rule 1 of Archon's `queryMetrics` (packages/workflows/src/metrics.ts): only the latest
-- terminal event of each node position (step name and loop path) counts, completions of relaying node
-- types are skipped, and an event with any malformed record is refused whole. Rules 2, 4 and 5 (a
-- name's first record fixes its definition, a re-run replaces earlier records, windows by `at`) are
-- applied by db/queries/factory-scorecard.sql, which reads these rows.
-- Like 0006's functions the writers never raise and wait at most 100 ms for a lock: they run in
-- Archon's write transaction. Run again, it changes nothing.

CREATE TABLE IF NOT EXISTS mc.metric_records (
  event_id uuid NOT NULL,
  ordinal integer NOT NULL,
  run_id uuid NOT NULL,
  step_id text NOT NULL,
  event_order bigint NOT NULL,
  completed_at timestamptz NOT NULL,
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('count', 'score')),
  unit text NOT NULL,
  calibrates text,
  subject text,
  instrument text,
  instrument_node text,
  value double precision NOT NULL,
  at timestamptz NOT NULL,
  PRIMARY KEY (event_id, ordinal)
);
CREATE INDEX IF NOT EXISTS metric_records_run ON mc.metric_records (run_id);
CREATE INDEX IF NOT EXISTS metric_records_name ON mc.metric_records (name);
COMMENT ON TABLE mc.metric_records IS
  'Archon metric records, verbatim (#630). A record with an instrument_node is stored without its measured-by, so no live query may compare those by model.';

CREATE OR REPLACE FUNCTION mc.metric_record_valid(r jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(
    jsonb_typeof(r) = 'object'
    AND coalesce(r->>'name' ~ '^[a-z0-9_]+(\.[a-z0-9_]+)*$', false)
    AND coalesce(r->>'kind' IN ('count', 'score'), false)
    AND jsonb_typeof(r->'value') = 'number'
    AND (r->>'kind' <> 'count' OR (r->>'value')::double precision >= 0)
    AND jsonb_typeof(r->'unit') = 'string'
    AND coalesce(jsonb_typeof(r->'subject'), 'null') IN ('string', 'null')
    AND (NOT r ? 'at' OR (jsonb_typeof(r->'at') = 'string'
      AND r->>'at' ~ '(Z|[+-][0-9]{2}:?[0-9]{2})$' AND pg_input_is_valid(r->>'at', 'timestamptz')))
    AND NOT EXISTS (SELECT 1 FROM jsonb_object_keys(r) k
      WHERE k NOT IN ('name', 'kind', 'unit', 'subject', 'at', 'runs', 'instrument', 'instrument_node', 'value', 'calibrates')),
    false)
$$;

CREATE OR REPLACE FUNCTION mc.project_metric_records(p_run_id uuid)
RETURNS void LANGUAGE plpgsql SET lock_timeout = '100ms' AS $$
BEGIN
  DELETE FROM mc.metric_records WHERE run_id = p_run_id;
  INSERT INTO mc.metric_records
  SELECT t.id, r.ord::int, t.workflow_run_id, t.step_name, coalesce(t.event_order, 0), t.created_at,
    r.rec->>'name', r.rec->>'kind', r.rec->>'unit', r.rec->>'calibrates', r.rec->>'subject',
    r.rec->>'instrument', r.rec->>'instrument_node', (r.rec->>'value')::double precision,
    coalesce((r.rec->>'at')::timestamptz, t.created_at)
  FROM (SELECT DISTINCT ON (e.step_name, coalesce(e.data->'invocation'->'loopPath', '[]'::jsonb)) e.*
          FROM public.remote_agent_workflow_events e
         WHERE e.workflow_run_id = p_run_id AND e.event_type IN ('node_completed', 'node_failed')
           AND e.step_name IS NOT NULL
         ORDER BY e.step_name, coalesce(e.data->'invocation'->'loopPath', '[]'::jsonb),
           coalesce(e.event_order, 0) DESC, e.created_at DESC, e.id DESC) t
  CROSS JOIN LATERAL jsonb_array_elements(t.data->'structured_output'->'metrics') WITH ORDINALITY r(rec, ord)
  WHERE t.event_type = 'node_completed'
    AND jsonb_typeof(t.data->'structured_output'->'metrics') = 'array'
    AND coalesce(t.data->>'type', '') NOT IN ('workflow', 'loop_group', 'compose_fan_out_instance')
    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(t.data->'structured_output'->'metrics') x(rec)
      WHERE NOT mc.metric_record_valid(x.rec));
END $$;

CREATE OR REPLACE FUNCTION mc.project_metric_records_trigger() RETURNS trigger LANGUAGE plpgsql
SET lock_timeout = '100ms' AS $$
BEGIN
  IF (NEW.event_type = 'node_completed' AND NEW.data->'structured_output'->>'metrics' IS NOT NULL)
     OR EXISTS (SELECT 1 FROM mc.metric_records m WHERE m.run_id = NEW.workflow_run_id) THEN
    PERFORM mc.project_metric_records(NEW.workflow_run_id);
  END IF;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  PERFORM mc.record_projection_error(TG_NAME, NEW.workflow_run_id, NEW.id, SQLSTATE, SQLERRM);
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION mc.drop_metric_records_trigger() RETURNS trigger LANGUAGE plpgsql
SET lock_timeout = '100ms' AS $$
BEGIN
  DELETE FROM mc.metric_records WHERE run_id = OLD.id;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  PERFORM mc.record_projection_error(TG_NAME, OLD.id, NULL, SQLSTATE, SQLERRM);
  RETURN NULL;
END $$;

CREATE OR REPLACE TRIGGER mc_project_metric_records AFTER INSERT ON public.remote_agent_workflow_events
  FOR EACH ROW WHEN (NEW.event_type IN ('node_completed', 'node_failed'))
  EXECUTE FUNCTION mc.project_metric_records_trigger();
CREATE OR REPLACE TRIGGER mc_project_metric_records_delete AFTER DELETE ON public.remote_agent_workflow_runs
  FOR EACH ROW EXECUTE FUNCTION mc.drop_metric_records_trigger();

DO $$
DECLARE r record; v_sqlstate text; v_message text;
BEGIN
  FOR r IN SELECT DISTINCT workflow_run_id FROM public.remote_agent_workflow_events
    WHERE event_type = 'node_completed' AND (data->'structured_output'->>'metrics') IS NOT NULL LOOP
    BEGIN
      PERFORM mc.project_metric_records(r.workflow_run_id);
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_message = MESSAGE_TEXT;
      v_sqlstate := SQLSTATE;
      IF NOT EXISTS (SELECT 1 FROM mc.projection_errors p
        WHERE p.run_id = r.workflow_run_id AND p.sqlstate = v_sqlstate AND p.message = v_message) THEN
        PERFORM mc.record_projection_error('metric_records', r.workflow_run_id, NULL, v_sqlstate, v_message);
      END IF;
    END;
  END LOOP;
END $$;
