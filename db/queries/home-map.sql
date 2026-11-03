-- The live part of the factory map (PRD 4.1): the drawing is app/map/factory-map.json, and these
-- rows are what its chips count. $2 is the pin the address names, '' for the current version.
-- The version the address names, as the version strip lists it: a pin with stored architecture,
-- for a factory with a lap (an empty factory does not borrow the shared pin history).
SELECT 'version' AS kind, NULL::uuid AS run_id, NULL::text AS workflow, NULL::text[] AS steps,
  NULL::integer AS number, NULL::text AS title, NULL::text AS url
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
-- steps, newest first, and the issue it claimed. The browser counts it on the card covering its
-- deepest running step.
SELECT 'lap', l.run_id, l.workflow_name, s.steps, c.issue_number, i.title, i.url
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
LEFT JOIN mc.issues i ON i.factory = l.factory AND i.number = c.issue_number
WHERE l.factory = $1 AND l.status = 'running'
  AND ($2 = '' OR EXISTS (SELECT 1 FROM mc.versions vr
    WHERE vr.factory = l.factory AND vr.digest = l.digest AND vr.pin_sha = $2))
UNION ALL
-- Each open pull request whose latest app check came out FAIL overall.
SELECT 'failing', NULL, NULL, NULL, pr.number, pr.title, pr.url
FROM mc.pull_requests pr
JOIN LATERAL (
  SELECT s.output ->> 'overall' AS overall
  FROM mc.lap_steps s
  JOIN mc.laps l ON l.run_id = s.run_id
  WHERE l.factory = pr.factory AND s.step_id = 'check-app'
    AND substring(s.output ->> 'pr' FROM '([0-9]+)/?$')::integer = pr.number
  ORDER BY s.started_at DESC NULLS LAST, s.run_id LIMIT 1
) latest ON latest.overall = 'FAIL'
WHERE pr.factory = $1 AND pr.state = 'open'
