# Engineering

How this repository is built. The product is `docs/mission-control.prd.md`; this file is how.

## Layout

| Path | What lives there |
|---|---|
| `app/` | The browser app: React 19, Vite 6, Tailwind v4, react-router 7. One file per screen under `app/routes/`, registered from the directory. |
| `server/` | Bun + Hono: serves the built app, `/api/health`, `/api/build-id`, and the sealing API for live queries. |
| `db/migrations/` | Numbered SQL files, applied in order by `bun run migrate`; each idempotent. |
| `db/queries/` | Every live query, one file each, named for the panel that reads it. |
| `function/` | The Neon Function that receives GitHub webhooks (Hono, TypeScript). |
| `parsers/` | Pure functions: comment formats, pin trailers, DECISIONS.md, the architecture parser. |
| `scripts/` | `fixture:branch`, `fixture:drop`, `fixture:write`, `fixture:seed`, `fixture:verify`, `migrate`, `backfill`, `rewind:create`. |
| `fixtures/` | `seed.sql` (written by `fixture:seed`), `expected-scorecard.sql` and its result `expected-scorecard.json`, `archon-schema.sql` (Archon's schema, for offline tests), `webhooks/` sample payloads, `pack/` (a snapshot of the pinned workflow pack), `factory-template/` (the fence files). |
| `harness/` | `design-probe.js` and the factory harness configuration. |
| `docs/design/archon-console/` | The Archon console's tokens and components, copied from Archon. The design source of truth. |
| `factories.json` | The factories the dashboard shows (PRD 11.6). |

## Rules

- TypeScript strict everywhere. Bun 1.4 for running, testing (`bun test`) and scripts. Biome for
  lint and format; `bun run check` runs type-check, lint and unit tests with no network.
- Every live query is a single read-only SELECT with no `now()`, no `random()` and no volatile
  function. Return timestamps; the browser computes elapsed times. Every table a live query reads
  has a primary key.
- Live queries read the dashboard's own tables, never Archon's `provider_event` rows.
- Nothing writes to Archon's tables. Triggers on them catch every error into `projection_errors`.
- Never connect to the `main` database branch from a check, a test or a lap. Use a `check-*` branch
  (`bun run fixture:branch`). `scripts/` refuses any other branch name for writes.
- Configuration by environment only: `MC_DATABASE_URL`, `NEON_REALTIME_SECRET`, `NEON_API_KEY`,
  `NEON_PROJECT_ID`. Never `DATABASE_URL`. Never commit a secret; `.mc-check.env` is gitignored.
- Serve on `127.0.0.1:<port>`, open as `http://localhost:<port>`, ports 8850-8864 only.
- Holdout scenario text never enters the dashboard's tables or screens: ids and verdicts only.
- Design: copy from `docs/design/archon-console/` (tokens in `index.css` and `theme.css`, and the
  components). Dark only. No color or font outside the tokens. Data in Geist Mono with tabular
  numbers; section labels mono, uppercase, tracked. Status colors: blue running, teal success,
  amber waiting, red failed; magenta is identity only. Empty states are one sentence and at most
  one button.
- Tests sit next to the code they test (`*.test.ts`). Parsers are tested on the literal examples in
  the PRD's appendix and on `fixtures/pack/`.
- Stop every process you start by its process id; never kill by name.

See [factory workflow policy](factory/WORKFLOW_POLICY.md) for factory-specific shared-workflow requirements.
