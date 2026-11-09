WITH base AS (
  -- The Runs screen: one page of a factory's runs, newest first, with every chip's count and the idle-poll
  -- count repeated on each row, so the rows and the counts come from one query (#517).
  -- $2 search ('' for none), $3 chip (a state name, '' for All), $4 'hide' or 'show' for idle polls,
  -- $5 the 0-based page, $6 the rows to a page (RUNS_PAGE_SIZE). A page past the end returns one row with no run, so the counts arrive.
  -- A live query may call no mc function and Realtime refuses a stable one, so the search joins text with
  -- `||` and `::text` casts only (concat_ws and int || text are stable).
  SELECT l.run_id, l.workflow_name, l.status, l.started_at, l.completed_at,
    -- RUN_STATE in app/lib/states.ts, restated: pending, cancelled and any status Archon adds are idle.
    CASE l.status WHEN 'running' THEN 'running' WHEN 'paused' THEN 'needs-you'
      WHEN 'failed' THEN 'failed' WHEN 'completed' THEN 'done' ELSE 'idle' END AS state,
    -- An idle poll is a completed run that found nothing to do: its facts step says path idle (any queue
    -- workflow), or it is an app check that selected nothing. factory-app-check keeps no step output, so
    -- a check that selected nothing is the one whose select completed and whose `pending` and `scope`
    -- steps, gated on `$select.output.found`, skipped. Its finalize and cleanup are all_done and always complete.
    (l.status = 'completed' AND (
      coalesce(facts.output ->> 'path' = 'idle', false)
      OR l.workflow_name = 'factory-app-check'
        AND EXISTS (SELECT 1 FROM mc.lap_steps sel
          WHERE sel.run_id = l.run_id AND sel.step_id = 'select' AND sel.status = 'completed')
        AND NOT EXISTS (SELECT 1 FROM mc.lap_steps o
          WHERE o.run_id = l.run_id AND o.step_id IN ('pending', 'scope') AND o.status <> 'skipped')
    )) AS idle_poll,
    -- The work item a run holds: its claim, else its facts step's item, else its number input.
    -- Restated in home-map.sql, health-workable.sql, failure-groups.sql and board.sql's rounds, and in
    -- scripts/live/attention.ts (a live query may call no mc function).
    -- db/queries/restated-rules.test.ts fails when the SQL copies disagree, the live script is an independent oracle.
    coalesce(c.issue_number, (facts.output -> 'item' ->> 'number')::int, l.issue_number) AS issue_number,
    i.title AS issue_title, st.step_id AS stop_step, st.line AS stop_line
  FROM mc.laps l
  LEFT JOIN LATERAL (
    SELECT c.issue_number FROM mc.claims c
    WHERE c.factory = l.factory AND c.run_id = l.run_id
    ORDER BY c.claimed_at DESC NULLS LAST, c.issue_number LIMIT 1
  ) c ON true
  LEFT JOIN mc.lap_steps facts ON facts.run_id = l.run_id AND facts.step_id = 'facts'
  LEFT JOIN mc.issues i ON i.factory = l.factory
    AND i.number = coalesce(c.issue_number, (facts.output -> 'item' ->> 'number')::int, l.issue_number)
  LEFT JOIN mc.run_stops st ON st.run_id = l.run_id
  WHERE l.factory = $1
), searched AS (
  SELECT * FROM base
  WHERE $2 = '' OR strpos(lower(
    base.workflow_name || ' ' || base.run_id::text || ' ' || coalesce('#' || base.issue_number::text, '')
    || ' ' || coalesce(base.issue_title, '') || ' ' || coalesce(base.stop_line, '')), lower($2)) > 0
), matched AS (
  SELECT * FROM searched WHERE NOT ($4 = 'hide' AND idle_poll)
), counts AS (
  SELECT count(*)::int AS all_count,
    count(CASE WHEN state = 'running' THEN 1 END)::int AS running_count,
    count(CASE WHEN state = 'needs-you' THEN 1 END)::int AS needs_you_count,
    count(CASE WHEN state = 'failed' THEN 1 END)::int AS failed_count,
    count(CASE WHEN state = 'done' THEN 1 END)::int AS done_count,
    count(CASE WHEN state = 'idle' THEN 1 END)::int AS idle_count,
    (SELECT count(*)::int FROM searched WHERE idle_poll) AS idle_polls
  FROM matched
), numbered AS (
  SELECT m.*, row_number() OVER (ORDER BY m.started_at DESC NULLS FIRST, m.run_id DESC)::int AS position
  FROM matched m WHERE $3 = '' OR m.state = $3
), page AS (
  SELECT * FROM numbered
  WHERE position > $5::bigint * $6::bigint AND position <= ($5::bigint + 1) * $6::bigint
)
SELECT counts.all_count, counts.running_count, counts.needs_you_count, counts.failed_count,
  counts.done_count, counts.idle_count, counts.idle_polls,
  p.run_id, p.position, p.workflow_name, p.status, p.state, p.idle_poll,
  p.started_at, p.completed_at, p.issue_number, p.issue_title, p.stop_step, p.stop_line,
  rnd.output ->> 'round' AS round, s.step_id, pr.pr_number, k.cost_usd
FROM counts
LEFT JOIN page p ON true
LEFT JOIN mc.lap_steps rnd ON rnd.run_id = p.run_id AND rnd.step_id = 'ship__deliver__rounds.round'
-- The step a run is on: its newest running step, or else the last one it started.
LEFT JOIN LATERAL (
  SELECT ls.step_id FROM mc.lap_steps ls
  WHERE ls.run_id = p.run_id
  ORDER BY ls.status = 'running' DESC, ls.started_at DESC NULLS LAST, ls.step_id LIMIT 1
) s ON true
LEFT JOIN LATERAL (
  SELECT ls.pr_number FROM mc.lap_steps ls
  WHERE ls.run_id = p.run_id AND ls.pr_number IS NOT NULL
  ORDER BY ls.started_at DESC NULLS LAST, ls.step_id LIMIT 1
) pr ON true
-- Every finished run of every step, repeats included. 0030 stores no cost on an aggregate row, so the sum
-- leaves the loop roll-ups out.
LEFT JOIN LATERAL (
  SELECT sum(a.cost_usd)::float8 AS cost_usd FROM mc.lap_step_attempts a WHERE a.run_id = p.run_id
) k ON true
