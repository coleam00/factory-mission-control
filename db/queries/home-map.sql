SELECT
  -- The live part of the factory map (PRD 4.1): the drawing is app/map/factory-map.json, and these
  -- rows are what its chips count. $2 is the pin the address names, '' for the current version.
  -- First the version the address names, as the version strip lists it: a pin with stored
  -- architecture, for a factory with a lap (an empty factory does not borrow the shared pin history).
  'version' AS kind, NULL::uuid AS run_id, NULL::text AS workflow, NULL::text[] AS steps,
  NULL::integer AS number, NULL::text AS title, NULL::text AS url, NULL::timestamptz AS at,
  NULL::text AS prs, NULL::text AS stop_line, NULL::integer AS asks
FROM mc.factories f
WHERE f.name = $1
  AND EXISTS (SELECT 1 FROM mc.laps l WHERE l.factory = f.name)
  AND EXISTS (
    SELECT 1 FROM mc.arch_versions a
    JOIN mc.pins p ON p.archon_sha = a.archon_sha
    WHERE $2 = '' OR p.sha = $2
  )
UNION ALL
-- Each running run of the factory, at a version the address names only the runs that ran it (a
-- run's version is its factory's digest's, labelled with its pin, PRD 11.2), with its running
-- steps, newest first, and the item it holds: its claim, else its facts step's item, else its
-- number input (the rule of runs.sql, health-workable.sql and board.sql's rounds, bound by
-- db/queries/restated-rules.test.ts). The browser counts it on the card covering its deepest running step.
SELECT 'lap', l.run_id, l.workflow_name, s.steps, coalesce(c.issue_number, (facts.output -> 'item' ->> 'number')::int, l.issue_number),
  i.title, i.url, NULL, NULL, NULL, NULL
FROM mc.laps l
LEFT JOIN LATERAL (
  SELECT array_agg(ls.step_id ORDER BY ls.started_at DESC NULLS LAST, ls.step_id) AS steps
  FROM mc.lap_steps ls WHERE ls.run_id = l.run_id AND ls.status = 'running'
) s ON true
LEFT JOIN LATERAL (
  SELECT c.issue_number FROM mc.claims c
  WHERE c.factory = l.factory AND c.run_id = l.run_id
  ORDER BY c.claimed_at DESC NULLS LAST, c.issue_number LIMIT 1
) c ON true
LEFT JOIN mc.lap_steps facts ON facts.run_id = l.run_id AND facts.step_id = 'facts'
LEFT JOIN mc.issues i ON i.factory = l.factory AND i.number = coalesce(c.issue_number, (facts.output -> 'item' ->> 'number')::int, l.issue_number)
WHERE l.factory = $1 AND l.status = 'running'
  AND ($2 = '' OR EXISTS (SELECT 1 FROM mc.versions vr
    WHERE vr.factory = l.factory AND vr.digest = l.digest AND vr.pin_sha = $2))
UNION ALL
-- Each open pull request whose latest app check came out FAIL overall. A check names its pull
-- request by the step's projected pr_number (prNumber's rule, mc.pr_number). Every pull request's
-- latest check is found in one pass over the factory's checks, as board.sql's checks do, not one
-- pass over every lap step per open pull request (#569).
SELECT 'failing', NULL, NULL, NULL, pr.number, pr.title, pr.url, NULL, NULL, NULL, NULL
FROM mc.pull_requests pr
JOIN (
  SELECT DISTINCT ON (s.pr_number) s.pr_number, s.output ->> 'overall' AS overall
  FROM mc.lap_steps s
  JOIN mc.laps l ON l.run_id = s.run_id
  WHERE l.factory = $1 AND s.step_id IN ('check-app', 'check')
    AND (s.step_id = 'check-app' OR l.workflow_name = 'factory-app-check')
    AND s.pr_number IS NOT NULL
  ORDER BY s.pr_number, s.started_at DESC NULLS LAST, s.run_id
) latest ON latest.pr_number = pr.number AND latest.overall = 'FAIL'
WHERE pr.factory = $1 AND pr.state = 'open'
UNION ALL
-- Each run of the factory waiting on a person (the chip counts the factory as it stands, not a
-- version): a paused run whose attention wait has no answer, with the item it holds (the lap
-- rule above). The issue's own title, and the question the run stopped on (its recorded stop
-- line, as the Runs page reads it) for the Board. `asks` is the number the question names, the
-- attention item's: the issue of a build-queue run that claimed it itself, the pull request a
-- queue ask names, else the item the run holds (a loop run has no attention number).
SELECT 'waiting', l.run_id, l.workflow_name, NULL, h.held,
  i.title, i.url, NULL, NULL, st.line,
  coalesce(a.item_number, h.held)
FROM mc.laps l
LEFT JOIN LATERAL (
  SELECT c.issue_number FROM mc.claims c
  WHERE c.factory = l.factory AND c.run_id = l.run_id
  ORDER BY c.claimed_at DESC NULLS LAST, c.issue_number LIMIT 1
) c ON true
LEFT JOIN mc.lap_steps facts ON facts.run_id = l.run_id AND facts.step_id = 'facts'
CROSS JOIN LATERAL (SELECT coalesce(c.issue_number, (facts.output -> 'item' ->> 'number')::int, l.issue_number) AS held) h
LEFT JOIN mc.issues i ON i.factory = l.factory AND i.number = h.held
LEFT JOIN mc.run_stops st ON st.run_id = l.run_id
LEFT JOIN mc.attention_items a ON a.run_id = l.run_id
WHERE l.factory = $1 AND l.attention_open
UNION ALL
-- One row for a factory on the queues, which is one that has run a workflow only the queue pack
-- has, and its attention items replace needs-owner.
SELECT 'queues', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
FROM mc.factories f
WHERE f.name = $1
  AND EXISTS (SELECT 1 FROM mc.laps l
    WHERE l.factory = f.name AND l.workflow_name IN ('archon-intake', 'archon-build-queue'))
UNION ALL
-- Each lap of the factory whose land step merged, the newest 200, timed when that step finished
-- (the run goes on after it). The browser keeps those of its own local day. A run has one step of
-- an id (the key is run_id, step_id), so the LIMIT 1 keeps every row and makes the database look
-- the step up by that key for each lap rather than scan every lap step (#569). The record step
-- below is found the same way.
SELECT * FROM (
  SELECT 'merged', l.run_id, l.workflow_name, NULL::text[], c.issue_number, i.title, i.url,
    coalesce(land.completed_at, land.started_at + land.duration_ms * interval '1 millisecond'),
    NULL::text, NULL::text, NULL::integer
  FROM mc.laps l
  JOIN LATERAL (
    SELECT land.started_at, land.completed_at, land.duration_ms FROM mc.lap_steps land
    WHERE land.run_id = l.run_id AND land.step_id = 'land'
      AND land.status = 'completed' AND land.output ->> 'outcome' = 'merged'
    LIMIT 1
  ) land ON true
  LEFT JOIN LATERAL (
    SELECT c.issue_number FROM mc.claims c
    WHERE c.factory = l.factory AND c.run_id = l.run_id
    ORDER BY c.claimed_at DESC NULLS LAST, c.issue_number LIMIT 1
  ) c ON true
  LEFT JOIN mc.issues i ON i.factory = l.factory AND i.number = c.issue_number
  WHERE l.factory = $1 AND l.workflow_name = 'archon-loop'
  ORDER BY 8 DESC NULLS LAST, l.run_id
  LIMIT 200
) merged
UNION ALL
-- Each run of the factory whose record step read pull requests back as merged (the queue's
-- sweep is the only record step with that output), the newest 200, with that list as JSON text
-- (Realtime refuses a set-returning function to expand it).
SELECT * FROM (
  SELECT 'merged', l.run_id, l.workflow_name, NULL::text[], NULL::integer, NULL::text, NULL::text,
    coalesce(rec.completed_at, rec.started_at + rec.duration_ms * interval '1 millisecond'),
    (rec.output -> 'merged')::text, NULL::text, NULL::integer
  FROM mc.laps l
  JOIN LATERAL (
    SELECT rec.started_at, rec.completed_at, rec.duration_ms, rec.output FROM mc.lap_steps rec
    WHERE rec.run_id = l.run_id AND rec.step_id = 'record'
      AND rec.status = 'completed' AND rec.output -> 'merged' IS NOT NULL
    LIMIT 1
  ) rec ON true
  WHERE l.factory = $1
  ORDER BY 8 DESC NULLS LAST, l.run_id
  LIMIT 200
) queue_merged
UNION ALL
-- The lens steps of the review block the engine skipped, for each running run, as `picks` rows of
-- one step each. Step ids repeat across the loop's rounds, so a skipped row counts only when it
-- finished at or after its round's mode step (the round's first) last started. Only a round whose
-- route step completed since then counts, and only for a lens its output says false: a round the
-- router never ran skips lenses without it, and a skip the router did not decide is not a decline.
SELECT 'picks', l.run_id, l.workflow_name, ARRAY[s.step_id], NULL, NULL, NULL, NULL, NULL, NULL, NULL
FROM mc.laps l
JOIN mc.lap_steps s ON s.run_id = l.run_id AND s.status = 'skipped'
  AND s.step_id ~ 'review__(seams|code|tests|errors|docs|ux)$'
JOIN mc.lap_steps p ON p.run_id = l.run_id
  AND p.step_id = regexp_replace(s.step_id, '__[a-z]+$', '__mode')
  AND s.completed_at >= p.started_at
JOIN mc.lap_steps rt ON rt.run_id = l.run_id
  AND rt.step_id = regexp_replace(s.step_id, '__[a-z]+$', '__route')
  AND rt.status = 'completed' AND rt.completed_at >= p.started_at
  AND rt.output ->> substring(s.step_id from '__([a-z]+)$') = 'false'
WHERE l.factory = $1 AND l.status = 'running'
