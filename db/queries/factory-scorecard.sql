WITH
  -- The factory's scorecard (#630): Archon's metric records (mc.metric_records, projected verbatim by
  -- 20261111T1300Z_metric_records.sql, which applies queryMetrics rule 1) counted by the rules of
  -- Archon's packages/workflows/src/metrics.ts queryMetrics that need no projection: rule 2 (a name's
  -- earliest record fixes its kind, unit and calibrates, and a record that disagrees is not counted), rule 4
  -- (the latest record per name, subject and instrument replaces earlier ones) and rule 5 (a record falls
  -- in a window by its at). A count is summed, a score averaged, n is the number of records.
  -- $1 is the factory. $2..$6 are the viewer's local midnights 60, 30, 14 and 7 days before the day after
  -- today, then that day's start (scorecardEdges in app/lib/factory-scorecard.ts), as instants, so the windows
  -- are whole local days whatever the clock changes between: 7 is [$5, $6), 7_before is [$4, $5), 30 is
  -- [$3, $6), 30_before is [$2, $3). The page passes them: a live query may not read the clock.
  -- Rule 2 reads every factory's records, as Archon's does: it compares definitions and sums nothing.
  scored AS (
    SELECT m.*, first_value(m.kind) OVER w AS def_kind, first_value(m.unit) OVER w AS def_unit,
      first_value(m.calibrates) OVER w AS def_calibrates
    FROM mc.metric_records m
    WHERE m.name IN ('sdlc.pr_merge_rate', 'sdlc.review_rounds', 'sdlc.review_one_round',
        'sdlc.review_five_plus_rounds', 'sdlc.test_lines_added', 'sdlc.production_lines_added')
      OR m.name ~ '^sdlc\.(issues_merged|issue_lead_time|issue_build_rounds|issue_asks)(\.[a-z0-9_]+)?$'
    WINDOW w AS (PARTITION BY m.name ORDER BY m.event_order, m.completed_at, m.event_id, m.ordinal)
  ),
  admitted AS (
    SELECT s.* FROM scored s JOIN mc.laps l ON l.run_id = s.run_id
    WHERE l.factory = $1 AND s.kind = s.def_kind AND s.unit = s.def_unit
      AND s.calibrates IS NOT DISTINCT FROM s.def_calibrates
  ),
  latest AS (
    SELECT * FROM (
      SELECT a.*, CASE WHEN a.subject IS NULL THEN 1 ELSE row_number() OVER (
        PARTITION BY a.name, a.subject, a.instrument
        ORDER BY a.event_order DESC, a.completed_at DESC, a.event_id DESC, a.ordinal DESC) END AS rn
      FROM admitted a) x
    WHERE x.rn = 1
  )
SELECT d.name, min(d.kind) AS kind, min(d.unit) AS unit,
  CASE WHEN min(d.kind) = 'count'
    THEN sum(d.value) FILTER (WHERE d.at >= $5::timestamptz AND d.at < $6::timestamptz)
    ELSE avg(d.value) FILTER (WHERE d.at >= $5::timestamptz AND d.at < $6::timestamptz) END::float8 AS value_7,
  count(*) FILTER (WHERE d.at >= $5::timestamptz AND d.at < $6::timestamptz)::int AS n_7,
  CASE WHEN min(d.kind) = 'count'
    THEN sum(d.value) FILTER (WHERE d.at >= $4::timestamptz AND d.at < $5::timestamptz)
    ELSE avg(d.value) FILTER (WHERE d.at >= $4::timestamptz AND d.at < $5::timestamptz) END::float8 AS value_7_before,
  count(*) FILTER (WHERE d.at >= $4::timestamptz AND d.at < $5::timestamptz)::int AS n_7_before,
  CASE WHEN min(d.kind) = 'count'
    THEN sum(d.value) FILTER (WHERE d.at >= $3::timestamptz AND d.at < $6::timestamptz)
    ELSE avg(d.value) FILTER (WHERE d.at >= $3::timestamptz AND d.at < $6::timestamptz) END::float8 AS value_30,
  count(*) FILTER (WHERE d.at >= $3::timestamptz AND d.at < $6::timestamptz)::int AS n_30,
  CASE WHEN min(d.kind) = 'count'
    THEN sum(d.value) FILTER (WHERE d.at >= $2::timestamptz AND d.at < $3::timestamptz)
    ELSE avg(d.value) FILTER (WHERE d.at >= $2::timestamptz AND d.at < $3::timestamptz) END::float8 AS value_30_before,
  count(*) FILTER (WHERE d.at >= $2::timestamptz AND d.at < $3::timestamptz)::int AS n_30_before
FROM latest d
GROUP BY d.name
ORDER BY d.name
