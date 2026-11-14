# What a live query may use

Every file in this directory except this one is a live query: one read-only `SELECT`, keyed by the
factory as `$1`, sealed by the server and subscribed through Neon Realtime (engineering.md,
PRD 11.1). The step screen's panels below `step-detail` also take the step's workflow and path as
`$2` and `$3`, so each answers with that step's files alone: a panel's first snapshot grows with
the size of its answer (#103). Every step query also takes, as its last parameter, the pin of the
version the step's address names, `''` for the current version, and `home-map` takes the pin of the
version the map's address names the same way, as `$2`; `step-versions` lists the versions either
can name. Realtime refuses some SQL a database would run. The table below is what it accepted
and rejected when `bun run test:live` ran each probe query on a check branch; `test:live` runs
them again on every run and fails when a verdict or an error differs from this table.

- `@neon/realtime`: 0.1.2
- Run: check-816754c9, check-ff19c267 and check-bfb770e3, 2026-10-25; the value of 16 KiB or more as the app check of #336 saw it, 2026-11-04; the two rows for a subquery inside an expression and a set operation reading an outer level as the app checks of #704 and #705 saw them on 2026-11-13 (their probes are written from the refused shapes and not yet run by `test:live`); the now() error as worded and the set-returning function accepted as the app checks of Archon runs 59a8f036-294b-455d-bee7-e70edc05d338, 40d584c2-e0dd-4334-9dba-06849dd62852 and 7dc63018-8448-436e-a1b6-69cab05c2577 saw them, 2026-11-13

| Feature                    | Probe                                                                                                                                                                                                                                                                               | Verdict  | Error                                                                                                                                |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| count(*) aggregate         | `SELECT count(*)::int AS running FROM mc.laps WHERE factory = $1 AND status = 'running'`                                                                                                                                                                                            | accepted |                                                                                                                                      |
| CTE                        | `WITH r AS (SELECT run_id, factory FROM mc.laps WHERE status = 'running') SELECT run_id FROM r WHERE factory = $1`                                                                                                                                                                  | accepted |                                                                                                                                      |
| LATERAL                    | `SELECT l.run_id, s.step_id FROM mc.laps l CROSS JOIN LATERAL (SELECT step_id FROM mc.lap_steps ls WHERE ls.run_id = l.run_id ORDER BY ls.started_at DESC LIMIT 1) s WHERE l.factory = $1`                                                                                          | accepted |                                                                                                                                      |
| DISTINCT ON                | `SELECT DISTINCT ON (run_id) run_id, step_id FROM mc.lap_steps ORDER BY run_id, started_at DESC`                                                                                                                                                                                    | accepted |                                                                                                                                      |
| window function            | `SELECT run_id, step_id, row_number() OVER (PARTITION BY run_id ORDER BY started_at) AS n FROM mc.lap_steps`                                                                                                                                                                        | accepted |                                                                                                                                      |
| now()                      | `SELECT run_id FROM mc.laps WHERE factory = $1 AND started_at < now()`                                                                                                                                                                                                              | rejected | upstream_rejected: unsupported query: live queries cannot track changes to a function that depends on time: pg_catalog.now(); pass the time as a parameter |
| VALUES list join           | `SELECT t.path, n.part FROM mc.arch_texts t JOIN (VALUES (0), (1)) AS n(part) ON n.part * 4000 < length(t.text)`                                                                                                                                                                    | accepted |                                                                                                                                      |
| set-returning function     | `SELECT t.path, n.part FROM mc.arch_texts t CROSS JOIN LATERAL generate_series(0, 1) AS n(part)`                                                                                                                                                                                    | accepted |                                                                                                                                      |
| value of 16 KiB or more    | `SELECT w.name, w.yaml FROM mc.arch_workflows w WHERE w.name = 'archon-deliver-block'`                                                                                                                                                                                              | accepted |                                                                                                                                      |
| LEFT JOIN LATERAL          | `SELECT l.run_id, s.step_id FROM mc.laps l LEFT JOIN LATERAL (SELECT step_id FROM mc.lap_steps ls WHERE ls.run_id = l.run_id ORDER BY ls.started_at DESC LIMIT 1) s ON true WHERE l.factory = $1`                                                                                   | accepted |                                                                                                                                      |
| UNION ALL                  | `SELECT l.run_id::text AS id FROM mc.laps l WHERE l.factory = $1 UNION ALL SELECT p.sha FROM mc.pins p`                                                                                                                                                                             | accepted |                                                                                                                                      |
| NOT EXISTS                 | `SELECT p.sha FROM mc.pins p WHERE NOT EXISTS (SELECT 1 FROM mc.laps l WHERE l.factory = $1 AND l.started_at > p.committed_at)`                                                                                                                                                     | accepted |                                                                                                                                      |
| starts_with()              | `SELECT p.sha, v.verdict FROM mc.pins p JOIN mc.verdicts v ON starts_with(p.sha, v.pin)`                                                                                                                                                                                            | accepted |                                                                                                                                      |
| EXISTS in CASE             | `SELECT i.number, CASE WHEN EXISTS (SELECT 1 FROM mc.issue_labels l WHERE l.issue_number = i.number) THEN 1 ELSE 0 END AS n FROM mc.issues i WHERE i.factory = $1`                                                                                                                  | accepted |                                                                                                                                      |
| EXISTS in FILTER           | `SELECT count(*) FILTER (WHERE EXISTS (SELECT 1 FROM mc.issue_labels l WHERE l.factory = i.factory AND l.issue_number = i.number)) AS n FROM mc.issues i WHERE i.factory = $1`                                                                                                      | rejected | upstream_rejected: the compiler refuses at the front end: unsupported query: subquery inside an expression the core does not analyse |
| set operation in a LATERAL | `SELECT l.run_id, g.title FROM mc.laps l LEFT JOIN LATERAL (SELECT min(x.title) AS title FROM (SELECT s.step_id AS title FROM mc.lap_steps s WHERE s.run_id = l.run_id UNION ALL SELECT e.step_id FROM mc.lap_steps e WHERE e.run_id = l.run_id) x) g ON true WHERE l.factory = $1` | rejected | upstream_rejected: the compiler refuses at the front end: set operation operand reads an outer query level                           |

A subquery inside an aggregate's `FILTER` is refused (the `EXISTS in CASE` and `NOT EXISTS` rows above are accepted), so a live query counts with a `LEFT JOIN LATERAL`
aggregate and reads the count in the expression (`work-orders` and `unstick` do). A `UNION ALL`
inside a lateral whose operand reads the outer row is refused too; the two operands become two
laterals, combined with `greatest` or `least`. Past the probes, `test:live` subscribes every file in
this directory and fails naming each one Realtime refuses.

A volatile function such as `now()` is rejected, so a query returns timestamps and the browser
computes elapsed times. The probe for a value of 16 KiB or more was accepted on 2026-11-04: the
subscription went live with defined data. The probe does not read the row or its length, so the
size of the seeded `archon-deliver-block` YAML on that run (its source file was 19,895 bytes) and
the largest value Realtime answers are not measured. Realtime did not answer such a query on
2026-10-25 (no rows and no error). A query that returns whole files still splits each into parts of
4000 characters, at most 16,000 bytes each, joining a `VALUES` list of part numbers, and the browser joins the parts. The constant
`generate_series(0, 1)` probe was accepted on 2026-11-13, but it is the only set-returning shape
probed: #402's query, which expanded a JSON column with `jsonb_array_elements` inside a scalar
subquery, was refused, and why was not recorded. So a live query calls no set-returning function as
a project rule, not a recorded verdict: `db/queries.test.ts` lists them in `SET_RETURNING` and fails
a live query that calls one.
`test:live` seals the probes in debug mode to record why a query was rejected; the app seals in
safe mode, where the browser sees only `upstream_rejected: upstream rejected` and no database
structure.

A user-defined function is not probed on a check branch. The app check of #357 saw a query that
called the `STABLE` function `mc.version_pin` refused with `upstream_rejected`, while the pre-change
ledger and the timeline query subscribed on the same socket. The cause is inferred, not measured: a
live query avoids calling a function of the `mc` schema (`db/queries.test.ts` fails one that does),
and that the rewritten query reading `mc.versions` subscribes is still to be shown by an app check.
The rejection reason is not recorded, because the app seals in safe mode.
