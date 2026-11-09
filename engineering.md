# Engineering

How this repository is built. The product is `docs/mission-control.prd.md`; this file is how.

## Layout

| Path | What lives there |
|---|---|
| `app/` | The browser app: React 19, Vite 6, Tailwind v4, react-router 7. One file per screen under `app/routes/`, registered from the directory; a file's name encodes its path (`.` separates segments, `$name` is a parameter: `f.$factory.versions.tsx` serves `/f/:factory/versions`, #73). |
| `server/` | Bun + Hono: serves the built app, `/api/health`, `/api/build-id`, and the sealing API for live queries. `/api/manager/*` is the Manager: a streaming chat and a daily briefing from a Claude agent with read-only tools. At start on a `check-*` branch it loads the factories file it serves into `mc.factories`, as `migrate -- --configured-factories` does, and fails to start if that fails; it never writes `main` or a `rewind-*` branch. |
| `db/migrations/` | SQL files, applied in full-filename order by `bun run migrate`; each idempotent. A new migration is named `<UTC timestamp>_<name>.sql`, the timestamp as `YYYYMMDDTHHMMZ` (`20261109T1430Z_stop_line.sql`), so parallel PRs cannot pick the same name; `bun run check` rejects any other new name and any shared prefix. The `00NN_` files predate this and keep their names (the runner records applied migrations by filename). A merged migration is never edited (main has applied it and never re-runs it): change it with a new migration. |
| `db/queries/` | Every live query, one file each, named for the panel that reads it. |
| `function/` | The Neon Function that receives GitHub webhooks (Hono, TypeScript). |
| `parsers/` | Pure functions: comment formats, pin trailers, DECISIONS.md, the architecture parser. |
| `scripts/` | `fixture:branch`, `fixture:drop`, `fixture:write`, `migrate`, `backfill`, `rewind:create`, `function:deploy`, `function:idle-check`. |
| `fixtures/` | `seed.sql`, `expected-scorecard.json`, `webhooks/` sample payloads, `pack/` (a snapshot of the pinned workflow pack), `factory-template/` (the fence files). |
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
- A live panel's speed is judged on the app's own work (owner decision, #13/#14, revised on #137):
  its query's `EXPLAIN ANALYZE` execution under 100 ms on the seed, and its rows on screen within
  500 ms of the first snapshot arriving (decode and render). Everything between the subscribe and
  that first snapshot is Neon's (connection, first-subscribe warm-up, delivery) and is judged only
  by Realtime `ready` within 2000 ms of navigation. Never show rows that did not come from a
  delivered subscription (no `initialData`), so a panel reads `ready` only when it is live.
- Nothing writes to Archon's tables. Triggers on them catch every error into `projection_errors`.
- Background repairs of the dashboard's own tables run as `reconcile:laps` / `reconcile` on the
  owner's schedule (every 10 minutes on the reference install), never by the app server or the
  webhook.
- Never connect to the `main` database branch from a check, a test or a lap. Use a `check-*` branch
  (`bun run fixture:branch`). `scripts/` refuses any other branch name for writes.
- Configuration by environment only: `MC_DATABASE_URL`, `NEON_REALTIME_SECRET`, `NEON_API_KEY`,
  `NEON_PROJECT_ID`, and optionally `MC_FACTORIES_FILE` (a factories file served instead of
  `factories.json`; checks use it to add a fixture-only factory, a real install leaves it unset).
  The Manager adds `MC_MANAGER_MODEL`, `MC_MANAGER_EFFORT`, `MC_MANAGER_MESSAGE_USD` and
  `MC_MANAGER_DAY_USD` (all optional, with defaults) and runs on the owner's Claude subscription:
  `CLAUDE_CODE_OAUTH_TOKEN`, or the machine's Claude login, set on the server. `ANTHROPIC_API_KEY`
  is optional and used only when set. With none of them the endpoint says which credential is missing.
  Never `DATABASE_URL`. Never commit a secret; `.mc-check.env` is gitignored.
- Serve on `127.0.0.1:<port>`, open as `http://localhost:<port>`, ports 8850-8864 only.
- Holdout scenario text from Archon's old rows never enters the dashboard's tables or screens. The factory no longer uses holdouts.
- Design: dark only, Geist for text and Geist Mono for data. Copy the components from
  `docs/design/archon-console/`. Colors live in one place: the tokens in `index.css` and
  `theme.css` there, copied identically into `app/styles.css` (`styles.test.ts` holds the copy,
  and the design probe fails any rendered color outside them). Change a color by changing its
  token, never inline. The surfaces are the near-black neutral console (cool charcoal, hue 265:
  page `--background`, then `--surface`, `--surface-elevated` and `--surface-hover` for the header,
  cards, panels and graph nodes), with no gradient and no blue tint on any surface. Dynamous Blue
  `#3B82F6` is the one accent (owner decisions #240 and 2026-10-28, "just some blue"): the active
  tab, the selection ring and focus; Dynamous Dark `#2563EB` for hover, Dynamous Light `#60A5FA`
  for link text. Text meets WCAG AA (4.5:1) on every surface. Status colors stay distinct from
  the accent: running is Dynamous Light and always pulses or glows; teal success, red failed
  (the brand's `#047857` and `#B91C1C` are the `--*-strong` tokens).
  Magenta is not used. Data in Geist Mono with tabular
  numbers; section labels mono, uppercase, tracked. Empty states are one sentence and at most one
  button.
- v2 design (owner decision 2026-11-03): `docs/design/v2/` is the design for every v2 screen (its
  README says what is binding). The role tokens in `docs/design/v2/tokens.css` are copied
  identically into `app/styles.css` beside the console tokens, and the design probe accepts them:
  `--role-source` sky (where work comes from, scripts), `--role-agent` blue (agents),
  `--role-test` teal (testing and shipping), `--role-person` violet (the manager and the owner).
  Waiting on a person is `--role-person`, never amber; amber is not used anywhere, and the existing
  amber usages move to violet (waiting) or teal/red (status) as each screen is redone. A map card's
  border and fill are its role color mixed into the panel surface (`--card-border-tint`,
  `--card-tint`), which is the one place a tint on a surface is allowed. Copy the mockup's wording
  exactly; plain words a newcomer understands, never pack jargon on a card.
- Use a table only for a list of records a person scans row by row (recent laps, scorecard
  comparison, decisions ledger). Counts, distributions, status across many items and progress are
  drawn: bars, grids, tiles, graphs (owner decision, #241). A drawn section keeps every number and
  link the table had, as text beside the drawing, and its live updates.
- Tests sit next to the code they test (`*.test.ts`). Parsers are tested on the literal examples in
  the PRD's appendix and on `fixtures/pack/`.
- Stop every process you start by its process id; never kill by name.

## Deploying the webhook Function

- `bun run function:deploy -- --branch <check-*|main>` bundles `function/index.ts` with neonctl
  (pinned in devDependencies), deploys it as the Neon Function `mcwebhook` (runtime nodejs24) on
  that branch, and prints its URL. It needs `NEON_API_KEY`, `NEON_PROJECT_ID` and
  `GITHUB_WEBHOOK_SECRET`; `GITHUB_TOKEN` is optional and only raises GitHub's rate limit. It sets
  the Function's `MC_DATABASE_URL` to that branch's pooled connection string, so the Function
  writes only the branch it runs on. It refuses every branch but `check-*` and `main`; `main` is
  the owner's step after merge (PRD 11.3). It prints no secret, though they sit in neonctl's
  arguments while it runs.
- `bun run function:deploy -- --branch <branch> --delete` removes it. A check that deploys deletes
  its Function before `fixture:drop`.
- `function/index.ts` is the deployed entry (Node, `pg`); `function/dev.ts` is the local one (Bun).
  Both serve `createWebhookApp`.
- Registering the webhook (the owner, once per repository, after deploying to `main`): in GitHub,
  Settings, Webhooks, Add webhook, on each repository in `factories.json` and on
  `coleam00/ai-software-factory`, whose pushes carry pins, verdicts and `DECISIONS.md`. Payload
  URL: the printed URL. Content type: `application/json`. Secret: the `GITHUB_WEBHOOK_SECRET` the
  deploy used. SSL verification on. Events, under "Let me select individual events": Issues, Issue
  comments, Pull requests, Pushes, Labels. "Recent Deliveries" shows each answer: 200 recorded,
  401 the secret differs, 400 the content type is not JSON.

See [factory workflow policy](factory/WORKFLOW_POLICY.md) for factory-specific shared-workflow requirements.
