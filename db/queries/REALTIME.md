# What a live query may use

Every file in this directory except this one is a live query: one read-only `SELECT`, keyed by the
factory as `$1`, sealed by the server and subscribed through Neon Realtime (engineering.md,
PRD 11.1). Realtime refuses some SQL a database would run. The table below is what it accepted
and rejected when `bun run test:live` ran each probe query on a check branch; `test:live` runs
them again on every run and fails when a verdict or an error differs from this table.

- `@neon/realtime`: 0.1.2
- Run: check-36d396dc, 2026-10-25

| Feature            | Probe                                                                                                                                                                                             | Verdict  | Error                                                                           |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------- |
| count(*) aggregate | `SELECT count(*)::int AS running FROM mc.laps WHERE factory = $1 AND status = 'running'`                                                                                                          | accepted |                                                                                 |
| CTE                | `WITH r AS (SELECT run_id, factory FROM mc.laps WHERE status = 'running') SELECT run_id FROM r WHERE factory = $1`                                                                                | accepted |                                                                                 |
| LATERAL            | `SELECT l.run_id, s.step_id FROM mc.laps l CROSS JOIN LATERAL (SELECT step_id FROM mc.lap_steps ls WHERE ls.run_id = l.run_id ORDER BY ls.started_at DESC LIMIT 1) s WHERE l.factory = $1`        | accepted |                                                                                 |
| DISTINCT ON        | `SELECT DISTINCT ON (run_id) run_id, step_id FROM mc.lap_steps ORDER BY run_id, started_at DESC`                                                                                                  | accepted |                                                                                 |
| window function    | `SELECT run_id, step_id, row_number() OVER (PARTITION BY run_id ORDER BY started_at) AS n FROM mc.lap_steps`                                                                                      | accepted |                                                                                 |
| now()              | `SELECT run_id FROM mc.laps WHERE factory = $1 AND started_at < now()`                                                                                                                            | rejected | upstream_rejected: unsupported query: scalar expression uses a mutable function |
| LEFT JOIN LATERAL  | `SELECT l.run_id, s.step_id FROM mc.laps l LEFT JOIN LATERAL (SELECT step_id FROM mc.lap_steps ls WHERE ls.run_id = l.run_id ORDER BY ls.started_at DESC LIMIT 1) s ON true WHERE l.factory = $1` | accepted |                                                                                 |
| UNION ALL          | `SELECT l.run_id::text AS id FROM mc.laps l WHERE l.factory = $1 UNION ALL SELECT p.sha FROM mc.pins p`                                                                                           | accepted |                                                                                 |
| NOT EXISTS         | `SELECT p.sha FROM mc.pins p WHERE NOT EXISTS (SELECT 1 FROM mc.laps l WHERE l.factory = $1 AND l.started_at > p.committed_at)`                                                                   | accepted |                                                                                 |
| starts_with()      | `SELECT p.sha, v.verdict FROM mc.pins p JOIN mc.verdicts v ON starts_with(p.sha, v.pin)`                                                                                                          | accepted |                                                                                 |

A volatile function such as `now()` is rejected, so a query returns timestamps and the browser
computes elapsed times. `test:live` seals the probes in debug mode to record why a query was
rejected; the app seals in safe mode, where the browser sees only `upstream_rejected: upstream
rejected` and no database structure.
