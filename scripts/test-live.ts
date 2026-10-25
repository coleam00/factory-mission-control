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
  '  Proves the factory strip is live against the check branch in .mc-check.env (run',
  '  `bun run fixture:branch` first): serves the app on a free port in 8850-8864, opens it in a',
  '  headless browser, inserts running laps and times them to the screen, holds the page open',
  '  --hold seconds (default 180) across seal renewals, re-runs the probes in',
  'db/queries/REALTIME.md, and runs the design probe. Writes realtime-timings.json,',
  '  realtime-features.json and realtime-design-probe.json to --out (default harness/.results/live).',
  '  On the same run it checks the versions screen against the seed, picks two versions, and times',
  '  `fixture:write pin` to that screen before and after the hold, writing version-strip-check.txt,',
  '  version-strip-timings.json, version-strip.png and version-strip-design-probe.json. It also',
  '  opens /steps/archon-loop/check-app, checks it against the seed, times description writes to',
  '  it across the same hold, and checks land and an unknown step, writing',
  '  step-detail-timings.json, step-detail.png and step-detail-design-probe.json.',
].join('\n');

export const LIMITS = { readyMs: 2000, firstSnapshotMs: 500, insertToScreenMs: 5000 };
const RENEWALS_IN_180S = 3;
const PANEL = '[data-live="status-strip"]';
/** Every live query the step screen reads, one panel each. */
const STEP_QUERIES = [
  'step-detail',
  'step-prompt',
  'step-subagents',
  'step-scripts',
  'step-hooks',
  'step-yaml',
];
const STEP_PATH = '/steps/archon-loop/check-app';
/**
 * check-app at the seed's current version, V2 (the newest pin with architecture rows): V2 drops
 * `briefs`, so it depends on `subject` alone (owner decision on #14).
 */
const SEED_CHECK_APP = {
  prompt: 'fixtures/pack/sdlc/loop/commands/loop-check-app.md',
  subagent: 'holdout-verifier',
  dependsOn: 'subject',
  hook: '.factory/hooks/holdout_fence.py',
  admitted: ['holdout-verifier', 'holdout-writer'],
};
const VERSIONS = '[data-live="version-strip"]';
const ENTRY = `${VERSIONS} [data-version-entry]`;
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
  limits: typeof LIMITS;
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

interface StepTimings {
  branch: string | null;
  port: number | null;
  /** When the last of the screen's panels reached `ready`, from navigation. */
  readyMs: number | null;
  /** Per query, from the panel asking for its seal to its first rows. */
  firstSnapshotMs: Record<string, number | null>;
  descriptionToScreenMs: number | null;
  holdSeconds: number;
  renewals: number | null;
  afterHoldDescriptionToScreenMs: number | null;
  noReload: boolean | null;
  limits: typeof LIMITS;
}

interface Version {
  archon_sha: string;
  factory_sha: string;
}

/** The architecture key of the seed's current version, as the step queries choose it. */
async function currentVersion(db: Db): Promise<Version> {
  const [version] = await db.query(
    `SELECT a.archon_sha, a.factory_sha FROM mc.arch_versions a
       JOIN mc.pins p ON p.archon_sha = a.archon_sha
      ORDER BY p.committed_at DESC, a.parsed_at DESC LIMIT 1`,
  );
  if (!version) throw new Error('the check branch has no pin with architecture rows');
  return version as unknown as Version;
}

const stepPanelsReady = `document.querySelectorAll('${STEP_QUERIES.map((q) => `[data-live="${q}"][data-state="ready"]`).join(', ')}').length === ${STEP_QUERIES.length}`;

/** Where check-app's screen differs from the seed: one line each. */
async function checkAppMismatches(page: Page, repoRoot: string): Promise<string[]> {
  const shown = await page.evaluate<{
    prompt: string | null;
    subagent: boolean;
    dependsOn: string | null;
    hook: boolean;
    admitted: string[];
  }>(`({
    prompt: document.querySelector('[data-live="step-prompt"] [data-prompt]')?.textContent ?? null,
    subagent: document.querySelector('[data-live="step-subagents"] [data-subagent="${SEED_CHECK_APP.subagent}"]') !== null,
    dependsOn: document.querySelector('[data-depends-on]')?.getAttribute('data-depends-on') ?? null,
    hook: document.querySelector('[data-live="step-hooks"] [data-hook="${SEED_CHECK_APP.hook}"]') !== null,
    admitted: [...document.querySelectorAll('[data-live="step-hooks"] [data-admitted-agent]')]
      .map((el) => el.getAttribute('data-admitted-agent')).sort(),
  })`);
  const failures: string[] = [];
  if (shown.prompt !== readFileSync(join(repoRoot, SEED_CHECK_APP.prompt), 'utf-8')) {
    failures.push(`check-app's prompt is not ${SEED_CHECK_APP.prompt} byte for byte`);
  }
  if (!shown.subagent) failures.push(`check-app shows no subagent ${SEED_CHECK_APP.subagent}`);
  if (shown.dependsOn !== SEED_CHECK_APP.dependsOn) {
    failures.push(`check-app depends on "${shown.dependsOn}", not "${SEED_CHECK_APP.dependsOn}"`);
  }
  if (!shown.hook) failures.push(`check-app shows no hook ${SEED_CHECK_APP.hook}`);
  if (shown.admitted.join() !== SEED_CHECK_APP.admitted.join()) {
    failures.push(`the fence admits ${shown.admitted.join(', ')}`);
  }
  return failures;
}

interface VersionStripTimings {
  branch: string | null;
  port: number | null;
  readyMs: number | null;
  firstSnapshotMs: number | null;
  pinToScreenMs: number | null;
  holdSeconds: number;
  renewals: number | null;
  afterHoldPinToScreenMs: number | null;
  noReload: boolean | null;
  links: { scorecard: string | null; diff: string | null };
  limits: typeof LIMITS;
}

interface ShownEntry {
  kind: string | null;
  digest: string | null;
  pin: string | null;
  date: string | null;
  reason: string | null;
  hypothesis: string | null;
  measure: string | null;
}

const entriesOnScreen = `[...document.querySelectorAll('${ENTRY}')].map((li) => ({
  kind: li.getAttribute('data-kind'),
  digest: li.getAttribute('data-digest'),
  pin: li.getAttribute('data-pin'),
  date: li.querySelector('[data-date]')?.getAttribute('data-date') ?? null,
  reason: li.querySelector('[data-reason]')?.getAttribute('data-reason') ?? null,
  hypothesis: li.querySelector('[data-hypothesis]')?.getAttribute('data-hypothesis') ?? null,
  measure: li.querySelector('[data-measure]')?.getAttribute('data-measure') ?? null,
}))`;

/** The versions screen against the seed's own versions and pins, read before any pin is written. */
async function seedVersionMismatches(
  page: Page,
  db: Db,
  factory: string,
): Promise<{ mismatches: string[]; report: string; digests: string[] }> {
  const shown = await page.evaluate<ShownEntry[]>(entriesOnScreen);
  const versions = await db.query(
    `SELECT v.digest, v.first_run_at, p.sha, p.reason, p.hypothesis, p.measure
     FROM mc.versions v LEFT JOIN mc.pins p ON p.sha = v.pin_sha
     WHERE v.factory = $1 ORDER BY v.first_run_at`,
    [factory],
  );
  const pins = await db.query('SELECT sha FROM mc.pins ORDER BY committed_at');
  const recorded = (text: unknown) =>
    typeof text === 'string' && text.trim() !== '' ? text : 'not recorded';
  const mismatches: string[] = [];
  if (shown.length !== versions.length) {
    mismatches.push(`the screen shows ${shown.length} entries, the seed has ${versions.length}`);
  }
  versions.forEach((version, i) => {
    const entry = shown[i];
    const expected: ShownEntry = {
      kind: 'version',
      digest: String(version.digest),
      pin: String(pins[i]?.sha),
      date: new Date(version.first_run_at as string).toISOString().slice(0, 10),
      reason: recorded(version.reason),
      hypothesis: recorded(version.hypothesis),
      measure: recorded(version.measure),
    };
    if (version.sha !== pins[i]?.sha) {
      mismatches.push(
        `seed version ${i + 1} is pinned by ${version.sha}, pin ${i + 1} is ${pins[i]?.sha}`,
      );
    }
    for (const key of Object.keys(expected) as (keyof ShownEntry)[]) {
      if (entry?.[key] !== expected[key]) {
        mismatches.push(`entry ${i + 1} ${key}: screen ${entry?.[key]}, seed ${expected[key]}`);
      }
    }
  });
  const report = [
    'screen:',
    ...shown.map((e) => `  ${JSON.stringify(e)}`),
    'seed (mc.versions joined to mc.pins, by first run):',
    ...versions.map((v) => `  ${JSON.stringify(v)}`),
    'seed pins by commit:',
    ...pins.map((p) => `  ${p.sha}`),
    ...mismatches,
    `mismatches: ${mismatches.length}`,
  ].join('\n');
  return { mismatches, report, digests: versions.map((v) => String(v.digest)) };
}

/** Picks the versions whose digests are given and returns the two compare links it then shows. */
async function selectAndLink(
  page: Page,
  digests: readonly string[],
): Promise<VersionStripTimings['links']> {
  for (const digest of digests) {
    await page.evaluate(
      `document.querySelector('${ENTRY}[data-digest=${JSON.stringify(digest)}] button').click()`,
    );
  }
  const shown = await page.evaluate<boolean>(
    pageWait(`document.querySelectorAll('${VERSIONS} a[data-compare]').length === 2`, 2000),
  );
  if (!shown) return { scorecard: null, diff: null };
  const href = (kind: string) =>
    page.evaluate<string | null>(
      `document.querySelector('${VERSIONS} a[data-compare="${kind}"]')?.getAttribute('href') ?? null`,
    );
  return { scorecard: await href('scorecard'), diff: await href('diff') };
}

/** The compare links must name the factory's scorecard and the diff, from V1 (`a`) to V2 (`b`). */
function checkLinks(
  links: VersionStripTimings['links'],
  base: string,
  factory: string,
  a: string,
  b: string,
): string[] {
  const failures: string[] = [];
  const expected = { scorecard: `/f/${factory}/scorecard`, diff: '/diff' };
  for (const kind of ['scorecard', 'diff'] as const) {
    const href = links[kind];
    if (href === null) {
      failures.push(`picking V1 and V2 showed no ${kind} link`);
      continue;
    }
    const url = new URL(href, base);
    if (
      url.pathname !== expected[kind] ||
      url.searchParams.get('a') !== a ||
      url.searchParams.get('b') !== b
    ) {
      failures.push(`the ${kind} link is ${href}, expected ${expected[kind]}?a=<V1>&b=<V2>`);
    }
  }
  return failures;
}

const setCheckAppDescription = `UPDATE mc.arch_steps SET description = $3
  WHERE archon_sha = $1 AND factory_sha = $2 AND workflow = 'archon-loop' AND path = 'check-app'`;

/** Writes check-app's stored description and times it from just before the write to the screen. */
async function descriptionToScreen(page: Page, db: Db, version: Version): Promise<number | null> {
  const text = `test:live ${crypto.randomUUID()}`;
  const started = performance.now();
  const shown = page.evaluate<boolean>(
    pageWait(
      `document.querySelector('[data-description]')?.textContent === '${text}'`,
      LIMITS.insertToScreenMs,
    ),
    LIMITS.insertToScreenMs + 5000,
  );
  await db.query(setCheckAppDescription, [version.archon_sha, version.factory_sha, text]);
  return (await shown) ? Math.round(performance.now() - started) : null;
}

/** Opens `path` on the app and waits until `ready` holds in the page. */
async function openStep(page: Page, base: string, path: string, ready: string): Promise<void> {
  await page.goto(`${base}${path}`);
  if (!(await page.evaluate<boolean>(pageWait(ready, READY_WAIT_MS)))) {
    throw new Error(`${path} did not reach data-state="ready" within ${READY_WAIT_MS} ms`);
  }
}

/** Runs `fixture:write pin` and times it from just before the spawn to the screen showing it. */
async function pinToScreen(page: Page, deps: Deps, target: number): Promise<number | null> {
  const started = performance.now();
  const shown = page.evaluate<boolean>(
    pageWait(`document.querySelectorAll('${ENTRY}').length === ${target}`, LIMITS.insertToScreenMs),
    LIMITS.insertToScreenMs + 5000,
  );
  const write = Bun.spawn(['bun', 'run', 'fixture:write', 'pin'], {
    cwd: deps.repoRoot,
    env: deps.env,
    stdout: 'ignore',
    stderr: 'inherit',
  });
  const exitCode = await write.exited;
  if (exitCode !== 0) {
    await shown;
    throw new Error(`bun run fixture:write pin exited ${exitCode}`);
  }
  return (await shown) ? Math.round(performance.now() - started) : null;
}

async function testLive(deps: Deps, outDir: string, holdSeconds: number): Promise<void> {
  const databaseUrl = await guardedDatabaseUrl(deps, 'check');
  const secret = deps.env.NEON_REALTIME_SECRET;
  if (!secret) throw new Error('NEON_REALTIME_SECRET is not set: run `bun run fixture:branch`');
  const { factories } = JSON.parse(readFileSync(join(deps.repoRoot, 'factories.json'), 'utf-8'));
  const factory: string = factories[0].name;
  mkdirSync(outDir, { recursive: true });

  const failures: string[] = [];
  const timings: Timings = {
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
  };
  const stepTimings: StepTimings = {
    branch: timings.branch,
    port: null,
    readyMs: null,
    firstSnapshotMs: {},
    descriptionToScreenMs: null,
    holdSeconds,
    renewals: null,
    afterHoldDescriptionToScreenMs: null,
    noReload: null,
    limits: LIMITS,
  };
  const inserted: string[] = [];
  /** check-app's description before test:live wrote it, restored at the end. */
  let described: { version: Version; was: unknown } | undefined;
  let stepPage: Page | undefined;
  const versionTimings: VersionStripTimings = {
    branch: timings.branch,
    port: null,
    readyMs: null,
    firstSnapshotMs: null,
    pinToScreenMs: null,
    holdSeconds,
    renewals: null,
    afterHoldPinToScreenMs: null,
    noReload: null,
    links: { scorecard: null, diff: null },
    limits: LIMITS,
  };
  const pinned: string[] = [];
  const db = deps.openDb(databaseUrl);
  let server: ReturnType<typeof Bun.spawn> | undefined;
  let page: Page | undefined;
  let versionsPage: Page | undefined;
  const latestPin = async () => {
    const [pin] = await db.query('SELECT sha FROM mc.pins ORDER BY committed_at DESC LIMIT 1');
    pinned.push(String(pin.sha));
  };
  try {
    const setup = Bun.spawnSync(['bun', 'run', 'setup'], {
      cwd: deps.repoRoot,
      stdout: 'ignore',
      stderr: 'inherit',
    });
    if (setup.exitCode !== 0) throw new Error(`bun run setup exited ${setup.exitCode}`);

    const port = await freePort();
    timings.port = port;
    stepTimings.port = port;
    versionTimings.port = port;
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
    const ready = await page.evaluate<boolean>(
      pageWait(`document.querySelector('${PANEL}[data-state="ready"]') !== null`, READY_WAIT_MS),
    );
    if (!ready) {
      throw new Error(`the strip did not reach data-state="ready" within ${READY_WAIT_MS} ms`);
    }
    const readyAt = await page.evaluate<number | null>(markTime('live:status-strip:ready'));
    const requestedAt = await page.evaluate<number | null>(markTime('live:status-strip:requested'));
    timings.readyMs = readyAt === null ? null : Math.round(readyAt);
    timings.firstSnapshotMs =
      readyAt === null || requestedAt === null ? null : Math.round(readyAt - requestedAt);
    const before = Number(
      await page.evaluate<string>(
        `document.querySelector('${PANEL} [data-count]').getAttribute('data-count')`,
      ),
    );

    timings.insertToScreenMs = await insertToScreen(page, db, inserted, factory, before + 1);
    deps.out(`first insert reached the strip in ${timings.insertToScreenMs ?? 'never'} ms`);

    stepPage = await openPage(deps.env);
    await openStep(stepPage, base, STEP_PATH, stepPanelsReady);
    await stepPage.evaluate('window.__mcNoReload = true');
    const readyMarks: number[] = [];
    for (const query of STEP_QUERIES) {
      const readyAt = await stepPage.evaluate<number | null>(markTime(`live:${query}:ready`));
      const requestedAt = await stepPage.evaluate<number | null>(
        markTime(`live:${query}:requested`),
      );
      if (readyAt !== null) readyMarks.push(readyAt);
      stepTimings.firstSnapshotMs[query] =
        readyAt === null || requestedAt === null ? null : Math.round(readyAt - requestedAt);
    }
    stepTimings.readyMs =
      readyMarks.length === STEP_QUERIES.length ? Math.round(Math.max(...readyMarks)) : null;
    failures.push(...(await checkAppMismatches(stepPage, deps.repoRoot)));
    writeFileSync(join(outDir, 'step-detail.png'), await stepPage.screenshot(1440));
    const version = await currentVersion(db);
    const [checkApp] = await db.query(
      `SELECT description FROM mc.arch_steps
        WHERE archon_sha = $1 AND factory_sha = $2 AND workflow = 'archon-loop' AND path = 'check-app'`,
      [version.archon_sha, version.factory_sha],
    );
    described = { version, was: checkApp?.description ?? null };
    stepTimings.descriptionToScreenMs = await descriptionToScreen(stepPage, db, version);
    deps.out(
      `first description write reached the step in ${stepTimings.descriptionToScreenMs ?? 'never'} ms`,
    );

    versionsPage = await openPage(deps.env);
    await versionsPage.goto(`${base}/f/${factory}/versions`);
    await versionsPage.evaluate('window.__mcNoReload = true');
    const versionsReady = await versionsPage.evaluate<boolean>(
      pageWait(`document.querySelector('${VERSIONS}[data-state="ready"]') !== null`, READY_WAIT_MS),
    );
    if (!versionsReady) {
      throw new Error(
        `the versions screen did not reach data-state="ready" within ${READY_WAIT_MS} ms`,
      );
    }
    const versionsReadyAt = await versionsPage.evaluate<number | null>(
      markTime('live:version-strip:ready'),
    );
    const versionsRequestedAt = await versionsPage.evaluate<number | null>(
      markTime('live:version-strip:requested'),
    );
    versionTimings.readyMs = versionsReadyAt === null ? null : Math.round(versionsReadyAt);
    versionTimings.firstSnapshotMs =
      versionsReadyAt === null || versionsRequestedAt === null
        ? null
        : Math.round(versionsReadyAt - versionsRequestedAt);
    const seed = await seedVersionMismatches(versionsPage, db, factory);
    writeFileSync(join(outDir, 'version-strip-check.txt'), `${seed.report}\n`);
    failures.push(...seed.mismatches.map((m) => `versions screen against the seed: ${m}`));
    writeFileSync(join(outDir, 'version-strip.png'), await versionsPage.screenshot(1440));

    const [v1, v2] = seed.digests;
    versionTimings.links = await selectAndLink(versionsPage, [v1, v2]);
    failures.push(...checkLinks(versionTimings.links, base, factory, v1, v2));

    const entries = await versionsPage.evaluate<number>(
      `document.querySelectorAll('${ENTRY}').length`,
    );
    versionTimings.pinToScreenMs = await pinToScreen(versionsPage, deps, entries + 1);
    await latestPin();
    deps.out(
      `first pin reached the versions screen in ${versionTimings.pinToScreenMs ?? 'never'} ms`,
    );

    deps.out(`holding the page open ${holdSeconds}s`);
    await deps.sleep(holdSeconds * 1000);
    timings.renewals = await page.evaluate<number>(
      `performance.getEntriesByName('live:status-strip:renewed').length`,
    );
    timings.afterHoldInsertToScreenMs = await insertToScreen(
      page,
      db,
      inserted,
      factory,
      before + 2,
    );
    timings.noReload = await page.evaluate<boolean>('window.__mcNoReload === true');
    await page.close();
    page = undefined;

    stepTimings.renewals = await stepPage.evaluate<number>(
      `performance.getEntriesByName('live:step-detail:renewed').length`,
    );
    stepTimings.afterHoldDescriptionToScreenMs = await descriptionToScreen(stepPage, db, version);
    stepTimings.noReload = await stepPage.evaluate<boolean>('window.__mcNoReload === true');

    await openStep(stepPage, base, '/steps/archon-loop/land', stepPanelsReady);
    const [land] = await db.query(
      `SELECT when_condition FROM mc.arch_steps
        WHERE archon_sha = $1 AND factory_sha = $2 AND workflow = 'archon-loop' AND path = 'land'`,
      [version.archon_sha, version.factory_sha],
    );
    const when = await stepPage.evaluate<string | null>(
      `document.querySelector('[data-when]')?.textContent ?? null`,
    );
    if (typeof land?.when_condition !== 'string' || when !== land.when_condition) {
      failures.push(`land shows when "${when}", stored "${land?.when_condition}"`);
    }
    await openStep(
      stepPage,
      base,
      '/steps/archon-loop/no-such-step',
      `document.querySelector('[data-live="step-detail"][data-state="ready"]') !== null`,
    );
    const unknown = await stepPage.evaluate<string>(
      `document.querySelector('[data-live="step-detail"]').textContent.trim()`,
    );
    if (unknown.match(/[.!?](\s|$)/g)?.length !== 1) {
      failures.push(`an unknown step shows "${unknown}", not one sentence`);
    }
    await stepPage.close();
    stepPage = undefined;

    versionTimings.renewals = await versionsPage.evaluate<number>(
      `performance.getEntriesByName('live:version-strip:renewed').length`,
    );
    versionTimings.afterHoldPinToScreenMs = await pinToScreen(versionsPage, deps, entries + 2);
    await latestPin();
    versionTimings.noReload = await versionsPage.evaluate<boolean>('window.__mcNoReload === true');
    await versionsPage.close();
    versionsPage = undefined;

    const probe = Bun.spawnSync(
      [
        'bun',
        'harness/design-probe.js',
        `${base}/`,
        '--out',
        join(outDir, 'realtime-design-probe.json'),
      ],
      { cwd: deps.repoRoot, env: deps.env, stdout: 'ignore', stderr: 'inherit' },
    );
    if (probe.exitCode !== 0) failures.push(`the design probe exited ${probe.exitCode}`);
    const stepProbe = Bun.spawnSync(
      [
        'bun',
        'harness/design-probe.js',
        `${base}${STEP_PATH}`,
        '--out',
        join(outDir, 'step-detail-design-probe.json'),
      ],
      { cwd: deps.repoRoot, env: deps.env, stdout: 'ignore', stderr: 'inherit' },
    );
    if (stepProbe.exitCode !== 0) {
      failures.push(`the design probe on ${STEP_PATH} exited ${stepProbe.exitCode}`);
    }
    const versionsProbe = Bun.spawnSync(
      [
        'bun',
        'harness/design-probe.js',
        `${base}/f/${factory}/versions`,
        '--out',
        join(outDir, 'version-strip-design-probe.json'),
      ],
      { cwd: deps.repoRoot, env: deps.env, stdout: 'ignore', stderr: 'inherit' },
    );
    if (versionsProbe.exitCode !== 0) {
      failures.push(`the design probe on the versions screen exited ${versionsProbe.exitCode}`);
    }
  } finally {
    writeFileSync(join(outDir, 'realtime-timings.json'), `${JSON.stringify(timings, null, 2)}\n`);
    writeFileSync(
      join(outDir, 'step-detail-timings.json'),
      `${JSON.stringify(stepTimings, null, 2)}\n`,
    );
    writeFileSync(
      join(outDir, 'version-strip-timings.json'),
      `${JSON.stringify(versionTimings, null, 2)}\n`,
    );
    // The pages and the server go first, so a failed cleanup below cannot leave them running.
    await page?.close().catch(() => undefined);
    await stepPage?.close().catch(() => undefined);
    await versionsPage?.close().catch(() => undefined);
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
    } catch (err) {
      failures.push(`removing the inserted laps failed: ${(err as Error).message}`);
    }
    try {
      if (described) {
        const { version, was } = described;
        await db.query(setCheckAppDescription, [version.archon_sha, version.factory_sha, was]);
      }
    } catch (err) {
      failures.push(`restoring check-app's description failed: ${(err as Error).message}`);
    }
    try {
      if (pinned.length > 0) {
        await db.query('DELETE FROM mc.pins WHERE sha = ANY($1::text[])', [
          `{${pinned.join(',')}}`,
        ]);
      }
    } catch (err) {
      failures.push(`removing the written pins failed: ${(err as Error).message}`);
    } finally {
      await db.close();
    }
  }

  const within = (value: number | null, limit: number) => value !== null && value <= limit;
  if (!within(timings.readyMs, LIMITS.readyMs)) {
    failures.push(`ready after ${timings.readyMs} ms, limit ${LIMITS.readyMs}`);
  }
  if (!within(timings.firstSnapshotMs, LIMITS.firstSnapshotMs)) {
    failures.push(
      `first snapshot after ${timings.firstSnapshotMs} ms, limit ${LIMITS.firstSnapshotMs}`,
    );
  }
  if (!within(timings.insertToScreenMs, LIMITS.insertToScreenMs)) {
    failures.push(
      `first insert reached the strip after ${timings.insertToScreenMs} ms, limit ${LIMITS.insertToScreenMs}`,
    );
  }
  if (!within(timings.afterHoldInsertToScreenMs, LIMITS.insertToScreenMs)) {
    failures.push(
      `insert after ${holdSeconds}s reached the strip after ${timings.afterHoldInsertToScreenMs} ms, limit ${LIMITS.insertToScreenMs}`,
    );
  }
  if (holdSeconds >= 180 && (timings.renewals ?? 0) < RENEWALS_IN_180S) {
    failures.push(
      `${timings.renewals} seal renewals in ${holdSeconds}s, expected at least ${RENEWALS_IN_180S}`,
    );
  }
  if (timings.noReload !== true) failures.push('the page reloaded');
  if (!within(stepTimings.readyMs, LIMITS.readyMs)) {
    failures.push(
      `the step screen was ready after ${stepTimings.readyMs} ms, limit ${LIMITS.readyMs}`,
    );
  }
  for (const query of STEP_QUERIES) {
    const ms = stepTimings.firstSnapshotMs[query] ?? null;
    if (!within(ms, LIMITS.firstSnapshotMs)) {
      failures.push(`${query}'s first snapshot after ${ms} ms, limit ${LIMITS.firstSnapshotMs}`);
    }
  }
  if (!within(stepTimings.descriptionToScreenMs, LIMITS.insertToScreenMs)) {
    failures.push(
      `the first description write reached the step after ${stepTimings.descriptionToScreenMs} ms, limit ${LIMITS.insertToScreenMs}`,
    );
  }
  if (!within(stepTimings.afterHoldDescriptionToScreenMs, LIMITS.insertToScreenMs)) {
    failures.push(
      `the description write after ${holdSeconds}s reached the step after ${stepTimings.afterHoldDescriptionToScreenMs} ms, limit ${LIMITS.insertToScreenMs}`,
    );
  }
  if (holdSeconds >= 180 && (stepTimings.renewals ?? 0) < RENEWALS_IN_180S) {
    failures.push(
      `${stepTimings.renewals} step-detail seal renewals in ${holdSeconds}s, expected at least ${RENEWALS_IN_180S}`,
    );
  }
  if (stepTimings.noReload !== true) failures.push('the step screen reloaded');
  if (!within(versionTimings.readyMs, LIMITS.readyMs)) {
    failures.push(
      `versions screen ready after ${versionTimings.readyMs} ms, limit ${LIMITS.readyMs}`,
    );
  }
  if (!within(versionTimings.firstSnapshotMs, LIMITS.firstSnapshotMs)) {
    failures.push(
      `versions screen first snapshot after ${versionTimings.firstSnapshotMs} ms, limit ${LIMITS.firstSnapshotMs}`,
    );
  }
  if (!within(versionTimings.pinToScreenMs, LIMITS.insertToScreenMs)) {
    failures.push(
      `first pin reached the versions screen after ${versionTimings.pinToScreenMs} ms, limit ${LIMITS.insertToScreenMs}`,
    );
  }
  if (!within(versionTimings.afterHoldPinToScreenMs, LIMITS.insertToScreenMs)) {
    failures.push(
      `pin after ${holdSeconds}s reached the versions screen after ${versionTimings.afterHoldPinToScreenMs} ms, limit ${LIMITS.insertToScreenMs}`,
    );
  }
  if (holdSeconds >= 180 && (versionTimings.renewals ?? 0) < RENEWALS_IN_180S) {
    failures.push(
      `${versionTimings.renewals} versions seal renewals in ${holdSeconds}s, expected at least ${RENEWALS_IN_180S}`,
    );
  }
  if (versionTimings.noReload !== true) failures.push('the versions screen reloaded');
  if (failures.length > 0) throw new Error(failures.join('\n'));
  deps.out(`live: ${JSON.stringify(timings)}`);
  deps.out(`step detail: ${JSON.stringify(stepTimings)}`);
  deps.out(`versions: ${JSON.stringify(versionTimings)}`);
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
