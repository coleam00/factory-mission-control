-- The scorecard per version of factory mission-control, from the definitions in PRD 4.2; its result
-- is fixtures/expected-scorecard.json. The oracle the scorecard panel is checked against, so it
-- reads only the dashboard's tables and shares nothing with panel code. Where 4.2 does not say how
-- an unfinished lap counts: count measures and cost use every lap of the version; time measures
-- (active hours, merges per active hour, lap-hours per merge, app-check share) use finished laps,
-- those with started_at and completed_at. Each measure's `laps` is the number of laps it used.
WITH lap AS (
  SELECT l.digest, l.status,
    l.started_at IS NOT NULL AND l.completed_at IS NOT NULL AS finished,
    l.started_at AT TIME ZONE 'UTC' AS started, l.completed_at AT TIME ZONE 'UTC' AS completed,
    extract(epoch FROM l.completed_at - l.started_at)::numeric / 3600 AS hours,
    (SELECT s.output->>'route' FROM mc.lap_steps s
      WHERE s.run_id = l.run_id AND s.step_id = 'pick') AS route,
    (SELECT s.output->>'outcome' FROM mc.lap_steps s
      WHERE s.run_id = l.run_id AND s.step_id = 'review') AS review,
    (SELECT s.output->>'outcome' FROM mc.lap_steps s
      WHERE s.run_id = l.run_id AND s.step_id = 'land') AS land,
    (SELECT s.duration_ms FROM mc.lap_steps s
      WHERE s.run_id = l.run_id AND s.step_id = 'check-app')::numeric / 3600000 AS check_app_hours,
    (SELECT coalesce(sum(s.cost_usd), 0) FROM mc.lap_steps s WHERE s.run_id = l.run_id) AS cost,
    (SELECT count(*) FROM mc.app_check_lines a
      WHERE a.run_id = l.run_id AND a.kind = 'holdout' AND a.verdict = 'FAIL'
        AND a.pre_existing = '') AS catches
  FROM mc.laps l
  WHERE l.factory = 'mission-control' AND l.workflow_name = 'archon-loop'
),
-- A UTC clock hour h is active when some finished lap ran in [h, h + 1 hour).
active AS (
  SELECT lap.digest, count(DISTINCT h) AS hours
  FROM lap, generate_series(date_trunc('hour', lap.started), lap.completed, interval '1 hour') AS h
  WHERE lap.finished AND h < lap.completed
  GROUP BY lap.digest
),
measured AS (
  SELECT v.digest, v.pin_sha, v.first_run_at,
    count(*) AS laps,
    count(*) FILTER (WHERE lap.finished) AS finished,
    count(*) FILTER (WHERE lap.land = 'merged') AS merges,
    count(*) FILTER (WHERE lap.route = 'none') AS empty_laps,
    count(*) FILTER (WHERE lap.status = 'failed') AS failed_laps,
    count(*) FILTER (WHERE lap.review = 'sent-back') AS send_backs,
    count(*) FILTER (WHERE lap.land = 'refused') AS gate_refusals,
    coalesce(max(active.hours), 0) AS active_hours,
    sum(lap.hours) FILTER (WHERE lap.finished) AS lap_hours,
    sum(lap.check_app_hours) FILTER (WHERE lap.finished) AS check_app_hours,
    sum(lap.cost) AS cost,
    sum(lap.catches) AS catches
  FROM mc.versions v
  JOIN lap ON lap.digest = v.digest
  LEFT JOIN active ON active.digest = v.digest
  WHERE v.factory = 'mission-control'
  GROUP BY v.digest, v.pin_sha, v.first_run_at
)
SELECT json_build_object(
  'factory', 'mission-control',
  'versions', json_agg(json_build_object(
    'digest', digest,
    'pin_sha', pin_sha,
    'first_run_at', to_char(first_run_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'measures', json_build_object(
      'laps', json_build_object('value', laps, 'laps', laps),
      'merges', json_build_object('value', merges, 'laps', laps),
      'empty_laps', json_build_object('value', empty_laps, 'laps', laps),
      'failed_laps', json_build_object('value', failed_laps, 'laps', laps),
      'send_backs', json_build_object('value', send_backs, 'laps', laps),
      'gate_refusals', json_build_object('value', gate_refusals, 'laps', laps),
      'active_hours', json_build_object('value', active_hours, 'laps', finished),
      'merges_per_active_hour', json_build_object(
        'value', round(merges / nullif(active_hours, 0)::numeric, 4), 'laps', finished),
      'lap_hours_per_merge', json_build_object(
        'value', round(lap_hours / nullif(merges, 0), 4), 'laps', finished),
      'app_check_share', json_build_object(
        'value', round(check_app_hours / nullif(lap_hours, 0), 4), 'laps', finished),
      'cost_per_merge', json_build_object('value', round(cost / nullif(merges, 0), 4), 'laps', laps),
      'new_holdout_catches', json_build_object('value', catches, 'laps', laps)
    )
  ) ORDER BY first_run_at)
) AS scorecard
FROM measured
