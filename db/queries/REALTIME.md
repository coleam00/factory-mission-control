# What a live query may use

Every file in this directory except this one is a live query: one read-only `SELECT`, keyed by the
factory as `$1`, sealed by the server and subscribed through Neon Realtime (engineering.md,
PRD 11.1). Realtime refuses some SQL a database would run. The table below is what it accepted
and rejected when `bun run test:live` ran each probe query on a check branch; `test:live` runs
them again on every run and fails when a verdict or an error differs from this table.

- `@neon/realtime`: 0.1.2
- Run: check-816754c9, 2026-10-25

| Feature                 | Probe                                                                                                                                                                                      | Verdict  | Error                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | ------------------------------------------------------------------------------- |
| count(*) aggregate      | `SELECT count(*)::int AS running FROM mc.laps WHERE factory = $1 AND status = 'running'`                                                                                                   | accepted |                                                                                 |
| CTE                     | `WITH r AS (SELECT run_id, factory FROM mc.laps WHERE status = 'running') SELECT run_id FROM r WHERE factory = $1`                                                                         | accepted |                                                                                 |
| LATERAL                 | `SELECT l.run_id, s.step_id FROM mc.laps l CROSS JOIN LATERAL (SELECT step_id FROM mc.lap_steps ls WHERE ls.run_id = l.run_id ORDER BY ls.started_at DESC LIMIT 1) s WHERE l.factory = $1` | accepted |                                                                                 |
| DISTINCT ON             | `SELECT DISTINCT ON (run_id) run_id, step_id FROM mc.lap_steps ORDER BY run_id, started_at DESC`                                                                                           | accepted |                                                                                 |
| window function         | `SELECT run_id, step_id, row_number() OVER (PARTITION BY run_id ORDER BY started_at) AS n FROM mc.lap_steps`                                                                               | accepted |                                                                                 |
| now()                   | `SELECT run_id FROM mc.laps WHERE factory = $1 AND started_at < now()`                                                                                                                     | rejected | upstream_rejected: unsupported query: scalar expression uses a mutable function |
| VALUES list join        | `SELECT t.path, n.part FROM mc.arch_texts t JOIN (VALUES (0), (1)) AS n(part) ON n.part * 4000 < length(t.text)`                                                                           | accepted |                                                                                 |
| set-returning function  | `SELECT t.path, n.part FROM mc.arch_texts t CROSS JOIN LATERAL generate_series(0, 1) AS n(part)`                                                                                           | rejected | upstream_rejected: unsupported query: set-returning function source             |
| value of 16 KiB or more | `SELECT w.name, w.yaml FROM mc.arch_workflows w WHERE w.name = 'archon-deliver-block'`                                                                                                     | rejected | no rows or error within 10s                                                     |

A volatile function such as `now()` is rejected, so a query returns timestamps and the browser
computes elapsed times. A query whose answer holds one value of about 16 KiB or more (the seed's
`archon-deliver-block` YAML is 19,895 bytes) never answers: no rows and no error. A query that
returns whole files therefore splits each into parts of 4000 characters, joining a `VALUES` list
of part numbers because `generate_series` is refused, and the browser joins the parts.
`test:live` seals the probes in debug mode to record why a query was rejected; the app seals in
safe mode, where the browser sees only `upstream_rejected: upstream rejected` and no database
structure.
