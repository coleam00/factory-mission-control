# Engineering

How this repository is built. The product is `docs/mission-control.prd.md`; this file is how.

## Layout

| Path | What lives there |
|---|---|
| `app/` | The browser app: React 19, Vite 6, Tailwind v4, react-router 7. One file per screen under `app/routes/`, registered from the directory; a file's name encodes its path (`.` separates segments, `$name` is a parameter: `f.$factory.versions.tsx` serves `/f/:factory/versions`, #73). |
| `server/` | Bun + Hono: serves the built app, `/api/health`, `/api/build-id`, and the sealing API for live queries. |
| `db/migrations/` | Numbered SQL files, applied in order by `bun run migrate`; each idempotent. A merged migration is never edited (main has applied it and never re-runs it): change it with a new, higher-numbered file. |
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
  Never `DATABASE_URL`. Never commit a secret; `.mc-check.env` is gitignored.
- Serve on `127.0.0.1:<port>`, open as `http://localhost:<port>`, ports 8850-8864 only.
- Holdout scenario text never enters the dashboard's tables or screens: ids and verdicts only.
- Design: dark only, Geist for text and Geist Mono for data. Copy the components from
  `docs/design/archon-console/`. Colors live in one place: the tokens in `index.css` and
  `theme.css` there, copied identically into `app/styles.css` (`styles.test.ts` holds the copy,
  and the design probe fails any rendered color outside them). Change a color by changing its
  token, never inline. The palette is the Dynamous brand (owner decision, #240): Dynamous Blue
  `#3B82F6` is the one accent (selection, the active tab, focus), Dynamous Dark `#2563EB` for
  hover and outlines, Dynamous Light `#60A5FA` for link text and secondary accents; the page is
  `#07090F` / `#080A13` under a faded brand gradient
  (`linear-gradient(to bottom, #07090F, rgba(30, 58, 138, 0.9), #080A13)`), never flat black;
  the header, factory strip and nav sit on deep blue (`#1E3A8A`-tinted); cards, panels and graph
  nodes on blue-tinted surface steps between `#07090F` and `#1E3A5F`, so sections separate by
  color; borders `rgba(255, 255, 255, 0.1)`. Text meets WCAG AA (4.5:1) on every surface. Status
  colors stay distinct from the accent: running is Dynamous Light and always pulses or glows,
  selection is solid Dynamous Blue; teal success, amber waiting, red failed (the brand's
  `#047857`, `#B45309` and `#B91C1C` are the `--*-strong` tokens). Magenta is not used. Data in Geist Mono with tabular
  numbers; section labels mono, uppercase, tracked. Empty states are one sentence and at most one
  button.
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
