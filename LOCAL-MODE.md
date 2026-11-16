# Local mode (self-hosted Postgres, no Neon)

Runs Mission Control against a plain Postgres that also holds Archon's tables. Neon mode is
unchanged and stays the default; local mode is on only with `MC_LIVE_MODE=local` (the
`scripts/local/*` entrypoints and the Dockerfile set it).

## How it differs

- Live panels poll `POST /api/live-rows` every 3 s instead of subscribing to Neon Realtime. The
  route runs only the committed `db/queries/*.sql`, with the same factory and argument checks as
  sealing, each in a `READ ONLY` transaction with a 5 s statement timeout.
- GitHub data arrives through `scripts/local/ingest.ts`, which runs `backfill --reconcile` and
  `reconcile:laps` every `MC_INGEST_INTERVAL_S` (300) seconds, not through webhooks and the Neon
  Function.
- `migrate`, `backfill`/`reconcile`, `reconcile:laps` and `arch:parse` connect to
  `MC_DATABASE_URL` without the Neon branch check, and refuse a `*.neon.tech` URL. Every other
  command that needs the Neon API (`fixture:*`, `rewind:create`, `function:*`, `test:live`,
  `projection:locks`) refuses.
- Rewind answers 503; factories are not synced at server start (`serve.ts` runs
  `migrate --configured-factories` instead).

## Commands

```
bun install --frozen-lockfile && bun run setup
bun run local:serve             # migrate --configured-factories, then serve on PORT (8850)
bun run local:ingest            # the GitHub reconcile loop; `-- --once` runs one pass
```

Container: `docker build --build-arg BUILD_ID=$(git rev-parse HEAD) -t mission-control:local .`,
then the default command serves and `bun scripts/local/ingest.ts` on the same image ingests.

## Environment

- `MC_DATABASE_URL` (required), `MC_LIVE_MODE=local`, `MC_FACTORIES_FILE`
- `MC_LISTEN_HOST` (default `127.0.0.1`), `PORT` (8850-8864, default 8850), `MC_SKIP_MIGRATE=1`,
  `MC_INGEST_INTERVAL_S`
- `GITHUB_TOKEN` for ingest of private repositories or above the unauthenticated rate limit
- `FACTORY_RUNTIME_CANDIDATE`: the build id, since the image has no git

## Limitations

- Panels are up to ~3 s stale and each open panel runs one query per poll; GitHub data is up to
  one ingest interval stale.
- The server has no authentication of its own: put an authenticating reverse proxy in front
  before setting `MC_LISTEN_HOST=0.0.0.0` beyond a trusted network.
- Timestamp and date columns are revived into `Date`s as Realtime does; other types arrive as
  node-postgres serialises them to JSON.
