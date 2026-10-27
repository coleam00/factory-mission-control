# What a live query may use

Every file in this directory except this one is a live query: one read-only `SELECT`, keyed by the
factory as `$1`, sealed by the server and subscribed through Neon Realtime (engineering.md,
PRD 11.1). The step screen's panels below `step-detail` also take the step's workflow and path as
`$2` and `$3`, so each answers with that step's files alone: a panel's first snapshot grows with
the size of its answer (#103). Every step query also takes, as its last parameter, the pin of the
version the step's address names, `''` for the current version; `step-versions` lists the versions
it can name. Realtime refuses some SQL a database would run. The table below is what it accepted
and rejected when `bun run test:live` ran each probe query on a check branch; `test:live` runs
them again on every run and fails when a verdict or an error differs from this table.

- `@neon/realtime`: 0.1.2
- Run: check-816754c9, check-ff19c267 and check-bfb770e3, 2026-10-25

| Feature                 | Probe                                                                                                                                                                                             | Verdict  | Error                                                                                                      |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------- |
| count(*) aggregate      | `SELECT count(*)::int AS running FROM mc.laps WHERE factory = $1 AND status = 'running'`                                                                                                          | accepted |                                                                                                            |
| CTE                     | `WITH r AS (SELECT run_id, factory FROM mc.laps WHERE status = 'running') SELECT run_id FROM r WHERE factory = $1`                                                                                | accepted |                                                                                                            |
| LATERAL                 | `SELECT l.run_id, s.step_id FROM mc.laps l CROSS JOIN LATERAL (SELECT step_id FROM mc.lap_steps ls WHERE ls.run_id = l.run_id ORDER BY ls.started_at DESC LIMIT 1) s WHERE l.factory = $1`        | accepted |                                                                                                            |
| DISTINCT ON             | `SELECT DISTINCT ON (run_id) run_id, step_id FROM mc.lap_steps ORDER BY run_id, started_at DESC`                                                                                                  | accepted |                                                                                                            |
| window function         | `SELECT run_id, step_id, row_number() OVER (PARTITION BY run_id ORDER BY started_at) AS n FROM mc.lap_steps`                                                                                      | accepted |                                                                                                            |
| now()                   | `SELECT run_id FROM mc.laps WHERE factory = $1 AND started_at < now()`                                                                                                                            | rejected | upstream_rejected: unsupported query: stable function is not approved for this operation: pg_catalog.now() |
| VALUES list join        | `SELECT t.path, n.part FROM mc.arch_texts t JOIN (VALUES (0), (1)) AS n(part) ON n.part * 4000 < length(t.text)`                                                                                  | accepted |                                                                                                            |
| set-returning function  | `SELECT t.path, n.part FROM mc.arch_texts t CROSS JOIN LATERAL generate_series(0, 1) AS n(part)`                                                                                                  | rejected | upstream_rejected: unsupported query: set-returning function source                                        |
| value of 16 KiB or more | `SELECT w.name, w.yaml FROM mc.arch_workflows w WHERE w.name = 'archon-deliver-block'`                                                                                                            | rejected | no rows or error within 10s                                                                                |
| LEFT JOIN LATERAL       | `SELECT l.run_id, s.step_id FROM mc.laps l LEFT JOIN LATERAL (SELECT step_id FROM mc.lap_steps ls WHERE ls.run_id = l.run_id ORDER BY ls.started_at DESC LIMIT 1) s ON true WHERE l.factory = $1` | accepted |                                                                                                            |
| UNION ALL               | `SELECT l.run_id::text AS id FROM mc.laps l WHERE l.factory = $1 UNION ALL SELECT p.sha FROM mc.pins p`                                                                                           | accepted |                                                                                                            |
| NOT EXISTS              | `SELECT p.sha FROM mc.pins p WHERE NOT EXISTS (SELECT 1 FROM mc.laps l WHERE l.factory = $1 AND l.started_at > p.committed_at)`                                                                   | accepted |                                                                                                            |
| starts_with()           | `SELECT p.sha, v.verdict FROM mc.pins p JOIN mc.verdicts v ON starts_with(p.sha, v.pin)`                                                                                                          | accepted |                                                                                                            |
| EXISTS in CASE          | `SELECT i.number, CASE WHEN EXISTS (SELECT 1 FROM mc.issue_labels l WHERE l.issue_number = i.number) THEN 1 ELSE 0 END AS n FROM mc.issues i WHERE i.factory = $1`                                | accepted |                                                                                                            |

A volatile function such as `now()` is rejected, so a query returns timestamps and the browser
computes elapsed times. A query whose answer holds one value of about 16 KiB or more (the seed's
`archon-deliver-block` YAML is 19,895 bytes) never answers: no rows and no error. A query that
returns whole files therefore splits each into parts of 4000 characters, joining a `VALUES` list
of part numbers because `generate_series` is refused, and the browser joins the parts.
`test:live` seals the probes in debug mode to record why a query was rejected; the app seals in
safe mode, where the browser sees only `upstream_rejected: upstream rejected` and no database
structure.
