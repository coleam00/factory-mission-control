import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createRealtimeClient, type WebSocketLike } from '@neon/realtime/client';
import { createRealtime, rawSql } from '@neon/realtime/server';
import { realtimeUrlFor } from '../server/live';
import { SERVE_PORTS } from '../server/ports';
import { openPage, type Page } from './lib/cdp';
import { type Deps, failing, guardedDatabaseUrl, type Main, runCli } from './lib/cli';
import type { Db } from './lib/db';

const USAGE = [
  'usage: bun run test:live [--out <dir>] [--hold <seconds>]',
  '  Proves the home screen is live against the check branch in .mc-check.env (run',
  '  `bun run fixture:branch` first): serves the app on a free port in 8850-8864, opens `/` in a',
  '  headless browser, checks the map against the seed, times inserted laps to the factory strip',
  '  and `fixture:write step` events to the map, holds the page open --hold seconds (default 180)',
  '  across seal renewals, clicks a step, re-runs the probes in db/queries/REALTIME.md, and runs',
  '  the design probe. Writes realtime-timings.json, realtime-features.json, home-map-timings.json,',
  '  home-map.png and home-map-design-probe.json to --out (default harness/.results/live).',
].join('\n');

export const LIMITS = { readyMs: 2000, firstSnapshotMs: 500, insertToScreenMs: 5000 };
const RENEWALS_IN_180S = 3;
const PANEL = '[data-live="status-strip"]';
const MAP = '[data-live="home-map"]';
/**
 * The seed's pinned architecture: the newest pin with architecture rows is V2 (V3 stores none),
 * whose loop drops `briefs` and adds `tally` (scripts/fixture/seed.ts).
 */
const SEED_LOOP = [
  'pick',
  'claim',
  'build',
  'ship',
  'subject',
  'check-app',
  'evidence',
  'review',
  'land',
  'deploy',
  'release',
  'tally',
];
const SEED_SHIP_STAGES = [
  'forge',
  'triage',
  'inv',
  'intel',
  'planned',
  'continues',
  'deliver',
  'outcome',
  'report',
];
/** The step `fixture:write` starts on running laps. */
const LIVE_STEP = 'review';
const CLICKED_STEP = 'check-app';
const FEATURE_TIMEOUT_MS = 10_000;
/** How long to wait for `ready` before giving up; the limit is judged on the page's own marks. */
const READY_WAIT_MS = 10_000;

export interface Feature {
  feature: string;
  probe: string;
  verdict: 'accepted' | 'rejected';
  error: string;
}

/** The probe table in REALTIME.md: one row per feature, the probe SQL in backticks. */
export function parseRealtimeFeatures(markdown: string): Feature[] {
  const rows = markdown.matchAll(
    /^\|\s*([^|]+?)\s*\|\s*`([^`]+)`\s*\|\s*(accepted|rejected)\s*\|\s*([^|]*?)\s*\|$/gm,
  );
  return [...rows].map(([, feature, probe, verdict, error]) => ({
    feature,
    probe,
    verdict: verdict as Feature['verdict'],
    error: error.trim(),
  }));
}

/** Bun's WebSocket takes headers (Realtime checks the origin) and wants protocols as a list. */
const BunWebSocket = WebSocket as unknown as new (
  url: string,
  options: { protocols: string[]; headers: Record<string, string> },
) => WebSocketLike;

/** Subscribes `probe` from this process as the browser would, and reports what Realtime said. */
async function runProbe(
  probe: string,
  factory: string,
  env: { databaseUrl: string; secret: string; origin: string },
): Promise<Pick<Feature, 'verdict' | 'error'>> {
  const sealer = createRealtime({
    // The app seals in safe mode, where a rejection reads `upstream rejected`; the table records why.
    debugMode: true,
    secret: env.secret,
    db: new URL(env.databaseUrl).pathname.slice(1),
  });
  const client = createRealtimeClient({
    url: realtimeUrlFor(env.databaseUrl),
    webSocketFactory: (url, protocols) =>
      new BunWebSocket(url, { protocols: [protocols].flat(), headers: { origin: env.origin } }),
  });
  try {
    const sealed = await sealer.seal({
      query: rawSql(probe, probe.includes('$1') ? [factory] : []),
    });
    const subscription = client.subscribe(sealed);
    return await new Promise((done) => {
      const timer = setTimeout(
        () => done({ verdict: 'rejected', error: 'no rows or error within 10s' }),
        FEATURE_TIMEOUT_MS,
      );
      subscription.onChange(({ status, data, error }) => {
        if (error) {
          clearTimeout(timer);
          done({ verdict: 'rejected', error: `${error.code}: ${error.message}` });
        } else if (status === 'live' && data !== undefined) {
          clearTimeout(timer);
          done({ verdict: 'accepted', error: '' });
        }
      });
    });
  } finally {
    client.close();
  }
}

async function freePort(): Promise<number> {
  for (let port = SERVE_PORTS.min; port <= SERVE_PORTS.max; port++) {
    try {
      Bun.listen({ hostname: '127.0.0.1', port, socket: { data() {} } }).stop(true);
      return port;
    } catch {}
  }
  throw new Error(`no free port in ${SERVE_PORTS.min}-${SERVE_PORTS.max}`);
}

async function waitForHealth(base: string, exited: () => boolean): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (exited()) throw new Error('the server exited before answering /api/health');
    const ok = await fetch(`${base}/api/health`).then(
      (res) => res.ok,
      () => false,
    );
    if (ok) return;
    await Bun.sleep(200);
  }
  throw new Error('the server did not answer /api/health within 15s');
}

/** An in-page promise: true once `condition` holds, false after `ms`; it watches, never polls. */
function pageWait(condition: string, ms: number): string {
  return `new Promise((done) => {
    const holds = () => ${condition};
    if (holds()) return done(true);
    const observer = new MutationObserver(() => {
      if (holds()) { observer.disconnect(); clearTimeout(timer); done(true); }
    });
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    const timer = setTimeout(() => { observer.disconnect(); done(false); }, ${ms});
  })`;
}

const countIs = (target: number) =>
  `document.querySelector('${PANEL} [data-count]')?.getAttribute('data-count') === '${target}'`;

const markTime = (name: string) => `performance.getEntriesByName('${name}')[0]?.startTime ?? null`;

/**
 * One panel's timings. The strip's inserts are running laps; the map's are `fixture:write step`
 * events, timed from starting the command.
 */
interface Timings {
  branch: string | null;
  port: number | null;
  readyMs: number | null;
  firstSnapshotMs: number | null;
  insertToScreenMs: number | null;
  holdSeconds: number;
  renewals: number | null;
  afterHoldInsertToScreenMs: number | null;
  noReload: boolean | null;
  /** Where clicking a map step went. */
  clickedTo?: string | null;
  limits: typeof LIMITS;
}

interface ShownNode {
  role: string;
  step: string | null;
  count: string | null;
}

const liveCountOf = (step: string) =>
  `document.querySelector('${MAP} [data-step="${step}"]')?.getAttribute('data-live-count')`;

const mapNodes = (page: Page) =>
  page.evaluate<ShownNode[]>(
    `[...document.querySelectorAll('${MAP} [data-node-role]')].map((el) => ({
      role: el.getAttribute('data-node-role'),
      step: el.getAttribute('data-step'),
      count: el.getAttribute('data-live-count'),
    }))`,
  );

/** Running laps per step for `factory`, straight from the laps tables. */
async function lapsOnSteps(db: Db, factory: string): Promise<Map<string, number>> {
  const rows = await db.query(
    `SELECT ls.step_id, count(DISTINCT ls.run_id)::int AS laps
       FROM mc.lap_steps ls JOIN mc.laps l ON l.run_id = ls.run_id
      WHERE l.factory = $1 AND l.workflow_name = 'archon-loop' AND l.status = 'running'
        AND ls.status = 'running'
      GROUP BY ls.step_id`,
    [factory],
  );
  return new Map(rows.map((r) => [String(r.step_id), Number(r.laps)]));
}

/** Where the map, in document order, differs from the seed and from `onStep`: one line each. */
function mapMismatches(nodes: ShownNode[], onStep: Map<string, number>): string[] {
  const failures: string[] = [];
  const idOf = (path: string | null) => path?.slice(path.lastIndexOf('/') + 1) ?? '';
  const ids = (role: string) => nodes.filter((n) => n.role === role).map((n) => idOf(n.step));
  if (ids('step').join() !== SEED_LOOP.join()) {
    failures.push(`the loop shows ${ids('step').join(', ')}`);
  }
  if (ids('stage').join() !== SEED_SHIP_STAGES.join()) {
    failures.push(`ship shows ${ids('stage').join(', ')}`);
  }
  const count = (...roles: string[]) => nodes.filter((n) => roles.includes(n.role)).length;
  for (const [what, shown, expected] of [
    ['inputs', count('input', 'frame-input'), 4],
    ['managers', count('manager'), 1],
    ['outputs', count('output'), 5],
  ] as const) {
    if (shown !== expected) failures.push(`the map shows ${shown} ${what}, not ${expected}`);
  }
  for (const node of nodes.filter((n) => n.count !== null)) {
    const expected = onStep.get(idOf(node.step)) ?? 0;
    if (Number(node.count) !== expected) {
      failures.push(`${node.step} shows ${node.count} laps, the database has ${expected}`);
    }
  }
  return failures;
}

/** Runs `fixture:write step` on `runId` and times it to LIVE_STEP's count reaching `target`. */
async function writeToScreen(
  page: Page,
  deps: Deps,
  runId: string,
  target: number,
): Promise<number | null> {
  const started = performance.now();
  const shown = page.evaluate<boolean>(
    pageWait(`${liveCountOf(LIVE_STEP)} === '${target}'`, LIMITS.insertToScreenMs),
    LIMITS.insertToScreenMs + 5000,
  );
  const write = Bun.spawn(
    [
      'bun',
      'run',
      'fixture:write',
      'step',
      '--run',
      runId,
      '--step',
      LIVE_STEP,
      '--event',
      'node_started',
    ],
    { cwd: deps.repoRoot, env: deps.env, stdout: 'ignore', stderr: 'inherit' },
  );
  const exitCode = await write.exited;
  if (exitCode !== 0) throw new Error(`fixture:write step exited ${exitCode}`);
  return (await shown) ? Math.round(performance.now() - started) : null;
}

/** Inserts one running lap and times it from just before the insert to the strip showing it. */
async function insertToScreen(
  page: Page,
  db: Db,
  inserted: string[],
  factory: string,
  target: number,
): Promise<number | null> {
  const started = performance.now();
  const shown = page.evaluate<boolean>(
    pageWait(countIs(target), LIMITS.insertToScreenMs),
    LIMITS.insertToScreenMs + 5000,
  );
  const runId = crypto.randomUUID();
  inserted.push(runId);
  await db.query(
    `INSERT INTO mc.laps (run_id, factory, workflow_name, status) VALUES ($1, $2, 'archon-loop', 'running')`,
    [runId, factory],
  );
  return (await shown) ? Math.round(performance.now() - started) : null;
}

const renewalsOf = (query: string) =>
  `performance.getEntriesByName('live:${query}:renewed').length`;

async function testLive(deps: Deps, outDir: string, holdSeconds: number): Promise<void> {
  const databaseUrl = await guardedDatabaseUrl(deps, 'check');
  const secret = deps.env.NEON_REALTIME_SECRET;
  if (!secret) throw new Error('NEON_REALTIME_SECRET is not set: run `bun run fixture:branch`');
  const { factories } = JSON.parse(readFileSync(join(deps.repoRoot, 'factories.json'), 'utf-8'));
  const factory: string = factories[0].name;
  mkdirSync(outDir, { recursive: true });

  const failures: string[] = [];
  const panelTimings = (): Timings => ({
    branch: deps.env.MC_CHECK_BRANCH ?? null,
    port: null,
    readyMs: null,
    firstSnapshotMs: null,
    insertToScreenMs: null,
    holdSeconds,
    renewals: null,
    afterHoldInsertToScreenMs: null,
    noReload: null,
    limits: LIMITS,
  });
  const timings = panelTimings();
  const mapTimings: Timings = { ...panelTimings(), clickedTo: null };
  const panels = [
    { name: 'the strip', query: 'status-strip', selector: PANEL, timings, file: 'realtime' },
    { name: 'the map', query: 'home-map', selector: MAP, timings: mapTimings, file: 'home-map' },
  ];
  const inserted: string[] = [];
  /** Laps `fixture:write` started LIVE_STEP on; the cleanup removes those events and steps. */
  const written: string[] = [];
  const db = deps.openDb(databaseUrl);
  let server: ReturnType<typeof Bun.spawn> | undefined;
  let page: Page | undefined;
  try {
    const setup = Bun.spawnSync(['bun', 'run', 'setup'], {
      cwd: deps.repoRoot,
      stdout: 'ignore',
      stderr: 'inherit',
    });
    if (setup.exitCode !== 0) throw new Error(`bun run setup exited ${setup.exitCode}`);

    const port = await freePort();
    timings.port = port;
    mapTimings.port = port;
    const base = `http://localhost:${port}`;
    const proc = Bun.spawn(['bun', 'server/main.ts', '--port', String(port)], {
      cwd: deps.repoRoot,
      env: deps.env,
      stdout: 'ignore',
      stderr: 'inherit',
    });
    server = proc;
    await waitForHealth(base, () => proc.exitCode !== null);

    const documented = parseRealtimeFeatures(
      readFileSync(join(deps.repoRoot, 'db', 'queries', 'REALTIME.md'), 'utf-8'),
    );
    const features: Feature[] = [];
    for (const row of documented) {
      const seen = await runProbe(row.probe, factory, { databaseUrl, secret, origin: base });
      features.push({ ...row, ...seen });
      if (seen.verdict !== row.verdict || seen.error !== row.error) {
        failures.push(
          `REALTIME.md says ${row.feature} is ${row.verdict}${row.error ? ` (${row.error})` : ''}; Realtime said ${seen.verdict}${seen.error ? ` (${seen.error})` : ''}`,
        );
      }
    }
    writeFileSync(
      join(outDir, 'realtime-features.json'),
      `${JSON.stringify({ branch: timings.branch, features }, null, 2)}\n`,
    );

    page = await openPage(deps.env);
    await page.goto(`${base}/`);
    await page.evaluate('window.__mcNoReload = true');
    for (const panel of panels) {
      const ready = await page.evaluate<boolean>(
        pageWait(
          `document.querySelector('${panel.selector}[data-state="ready"]') !== null`,
          READY_WAIT_MS,
        ),
      );
      if (!ready) {
        throw new Error(
          `${panel.name} did not reach data-state="ready" within ${READY_WAIT_MS} ms`,
        );
      }
      const readyAt = await page.evaluate<number | null>(markTime(`live:${panel.query}:ready`));
      const requestedAt = await page.evaluate<number | null>(
        markTime(`live:${panel.query}:requested`),
      );
      panel.timings.readyMs = readyAt === null ? null : Math.round(readyAt);
      panel.timings.firstSnapshotMs =
        readyAt === null || requestedAt === null ? null : Math.round(readyAt - requestedAt);
    }
    const before = Number(
      await page.evaluate<string>(
        `document.querySelector('${PANEL} [data-count]').getAttribute('data-count')`,
      ),
    );
    failures.push(...mapMismatches(await mapNodes(page), await lapsOnSteps(db, factory)));
    writeFileSync(join(outDir, 'home-map.png'), await page.screenshot(1440));
    const laps = await db.query(
      `SELECT l.run_id FROM mc.laps l
        WHERE l.factory = $1 AND l.workflow_name = 'archon-loop' AND l.status = 'running'
          AND NOT EXISTS (SELECT 1 FROM mc.lap_steps ls
                           WHERE ls.run_id = l.run_id AND ls.step_id = $2)
        ORDER BY l.run_id LIMIT 2`,
      [factory, LIVE_STEP],
    );
    if (laps.length < 2) throw new Error(`the check branch has ${laps.length} running laps, not 2`);
    const [firstLap, secondLap] = laps.map((l) => String(l.run_id));
    const onLiveStep = Number(await page.evaluate<string>(liveCountOf(LIVE_STEP)));

    timings.insertToScreenMs = await insertToScreen(page, db, inserted, factory, before + 1);
    deps.out(`first insert reached the strip in ${timings.insertToScreenMs ?? 'never'} ms`);
    written.push(firstLap);
    mapTimings.insertToScreenMs = await writeToScreen(page, deps, firstLap, onLiveStep + 1);
    deps.out(`first step event reached the map in ${mapTimings.insertToScreenMs ?? 'never'} ms`);

    deps.out(`holding the page open ${holdSeconds}s`);
    await deps.sleep(holdSeconds * 1000);
    for (const panel of panels) {
      panel.timings.renewals = await page.evaluate<number>(renewalsOf(panel.query));
    }
    timings.afterHoldInsertToScreenMs = await insertToScreen(
      page,
      db,
      inserted,
      factory,
      before + 2,
    );
    written.push(secondLap);
    mapTimings.afterHoldInsertToScreenMs = await writeToScreen(
      page,
      deps,
      secondLap,
      onLiveStep + 2,
    );

    const target = `/steps/archon-loop/${CLICKED_STEP}`;
    await page.evaluate(`document.querySelector('${MAP} [data-step="${CLICKED_STEP}"]').click()`);
    await page.evaluate<boolean>(pageWait(`location.pathname === '${target}'`, 2000));
    mapTimings.clickedTo = await page.evaluate<string>('location.pathname');
    if (mapTimings.clickedTo !== target) {
      failures.push(`clicking ${CLICKED_STEP} opened ${mapTimings.clickedTo}, not ${target}`);
    }
    timings.noReload = await page.evaluate<boolean>('window.__mcNoReload === true');
    mapTimings.noReload = timings.noReload;
    await page.close();
    page = undefined;

    const probe = Bun.spawnSync(
      [
        'bun',
        'harness/design-probe.js',
        `${base}/`,
        '--out',
        join(outDir, 'home-map-design-probe.json'),
      ],
      { cwd: deps.repoRoot, env: deps.env, stdout: 'ignore', stderr: 'inherit' },
    );
    if (probe.exitCode !== 0) failures.push(`the design probe exited ${probe.exitCode}`);
  } finally {
    for (const panel of panels) {
      writeFileSync(
        join(outDir, `${panel.file}-timings.json`),
        `${JSON.stringify(panel.timings, null, 2)}\n`,
      );
    }
    // The page and the server go first, so a failed cleanup below cannot leave them running.
    await page?.close().catch(() => undefined);
    if (server) {
      server.kill();
      await server.exited;
    }
    try {
      if (inserted.length > 0) {
        await db.query('DELETE FROM mc.laps WHERE run_id = ANY($1::uuid[])', [
          `{${inserted.join(',')}}`,
        ]);
      }
      if (written.length > 0) {
        const runs = `{${written.join(',')}}`;
        await db.query(
          'DELETE FROM remote_agent_workflow_events WHERE workflow_run_id = ANY($1::uuid[]) AND step_name = $2',
          [runs, LIVE_STEP],
        );
        await db.query('DELETE FROM mc.lap_steps WHERE run_id = ANY($1::uuid[]) AND step_id = $2', [
          runs,
          LIVE_STEP,
        ]);
      }
    } catch (err) {
      failures.push(`removing the inserted rows failed: ${(err as Error).message}`);
    } finally {
      await db.close();
    }
  }

  const within = (value: number | null, limit: number) => value !== null && value <= limit;
  for (const { name, timings: t } of panels) {
    if (!within(t.readyMs, LIMITS.readyMs)) {
      failures.push(`${name} was ready after ${t.readyMs} ms, limit ${LIMITS.readyMs}`);
    }
    if (!within(t.firstSnapshotMs, LIMITS.firstSnapshotMs)) {
      failures.push(
        `${name}'s first snapshot came after ${t.firstSnapshotMs} ms, limit ${LIMITS.firstSnapshotMs}`,
      );
    }
    if (!within(t.insertToScreenMs, LIMITS.insertToScreenMs)) {
      failures.push(
        `the first insert reached ${name} after ${t.insertToScreenMs} ms, limit ${LIMITS.insertToScreenMs}`,
      );
    }
    if (!within(t.afterHoldInsertToScreenMs, LIMITS.insertToScreenMs)) {
      failures.push(
        `the insert after ${holdSeconds}s reached ${name} after ${t.afterHoldInsertToScreenMs} ms, limit ${LIMITS.insertToScreenMs}`,
      );
    }
    if (holdSeconds >= 180 && (t.renewals ?? 0) < RENEWALS_IN_180S) {
      failures.push(
        `${t.renewals} seal renewals of ${name} in ${holdSeconds}s, expected at least ${RENEWALS_IN_180S}`,
      );
    }
  }
  if (timings.noReload !== true) failures.push('the page reloaded');
  if (failures.length > 0) throw new Error(failures.join('\n'));
  deps.out(`live: ${JSON.stringify(timings)}`);
  deps.out(`home map: ${JSON.stringify(mapTimings)}`);
}

export const main: Main = async (argv, deps) => {
  let values: { out?: string; hold?: string; help?: boolean };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        out: { type: 'string' },
        hold: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    }));
  } catch (error) {
    deps.err(`${error instanceof Error ? error.message : error}\n${USAGE}`);
    return 2;
  }
  if (values.help) {
    deps.out(USAGE);
    return 0;
  }
  const hold = Number(values.hold ?? 180);
  if (!Number.isInteger(hold) || hold < 0) {
    deps.err(`--hold takes whole seconds\n${USAGE}`);
    return 2;
  }
  const outDir = resolve(values.out ?? join(deps.repoRoot, 'harness', '.results', 'live'));
  return failing(deps, () => testLive(deps, outDir, hold));
};

if (import.meta.main) await runCli(main);
