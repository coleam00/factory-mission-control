import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createRealtimeClient, type WebSocketLike } from '@neon/realtime/client';
import { createRealtime, rawSql } from '@neon/realtime/server';
import { ISSUE_STATES, STATE_TOKEN } from '../app/lib/issue-graph';
import { OUTCOME_TOKEN, OUTCOMES } from '../app/lib/laps';
import { realtimeUrlFor } from '../server/live';
import { SERVE_PORTS } from '../server/ports';
import { seedLaps } from './fixture/seed-laps';
import { NEXT_TO_LABEL } from './fixture/write';
import { openPage, type Page } from './lib/cdp';
import { type Deps, failing, guardedDatabaseUrl, type Main, runCli } from './lib/cli';
import type { Db } from './lib/db';
import { rewindPhase } from './live/rewind';

const USAGE = [
  'usage: bun run test:live [--out <dir>] [--hold <seconds>]',
  '  Proves the home screen is live against the check branch in .mc-check.env (run',
  '  `bun run fixture:branch` first): serves the app on a free port in 8850-8864, opens `/` in a',
  '  headless browser, checks the map against the seed, times inserted laps to the factory strip',
  '  and `fixture:write step` events to the map, holds the page open --hold seconds (default 180)',
  '  across seal renewals, clicks a step, re-runs the probes in db/queries/REALTIME.md, and runs',
  '  the design probe. Writes realtime-timings.json, realtime-features.json, home-map-timings.json,',
  '  home-map.png and home-map-design-probe.json to --out (default harness/.results/live).',
  '  On the same run it checks the versions screen against the seed, picks two versions, and times',
  '  `fixture:write pin` to that screen before and after the hold, writing version-strip-check.txt,',
  '  version-strip-timings.json, version-strip.png and version-strip-design-probe.json.',
  '  It then opens the scorecard of V1 against V2 and of V1 against V3, checks every number against',
  '  fixtures/expected-scorecard.json and the not-yet-meaningful labels, and times',
  '  `fixture:write step --step land` on a V2 lap to the screen before and after the hold, writing',
  '  scorecard-vs-expected.json, scorecard-timings.json, scorecard.png and',
  "  scorecard-design-probe.json; it restores those laps' land steps afterwards.",
  '  It checks the decisions screen against the seed, times `fixture:write verdict --pin <V2>` and',
  '  `fixture:write decision` to that screen before and after the hold, writing ledger-check.txt,',
  '  decisions-ledger-timings.json, decisions-ledger.png and decisions-ledger-design-probe.json.',
  '  It checks the issues screen against the seed and times `fixture:write label` to it before and',
  '  after the hold, writing issue-graph-check.txt, phases-issue-graph-timings.json,',
  '  phases-issue-graph.png and phases-issue-graph-design-probe.json.',
  '  It checks the laps screen against the seed and times the same `fixture:write step` events to',
  '  their lanes before and after the hold, writing lanes-check.txt, lanes-recent-laps-timings.json,',
  '  lanes-recent-laps.png and lanes-recent-laps-design-probe.json.',
  "  Then it opens the diff of the two versions, checks it lists exactly the seed's scripted change,",
  '  and times a step inserted into the second version to that screen before and after the hold,',
  '  writing arch-diff-timings.json, arch-diff.png and arch-diff-design-probe.json.',
  '  It opens /steps/archon-loop/check-app, checks it against the seed, times description writes to',
  '  it across the same hold, and checks land and an unknown step, writing',
  '  step-detail-timings.json, step-detail.png and step-detail-design-probe.json.',
  '  It opens /rewind on a second server, makes a rewind branch of the check branch with',
  '  `bun run rewind:create` before the hold and another after it, switches to the first and back,',
  '  writing rewind-run.txt, rewind-timings.json, rewind.png and rewind-design-probe.json.',
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
const VERSIONS = '[data-live="version-strip"]';
const ENTRY = `${VERSIONS} [data-version-entry]`;
const SCORECARD = '[data-live="scorecard"]';
const DECISION_QUERIES = ['decisions-timeline', 'improvements-ledger'] as const;
const DECISION = '[data-live="decisions-timeline"] [data-decision-entry]';
const LEDGER = '[data-live="improvements-ledger"]';
const inLedger = (group: 'testing' | 'verdicts', pin: string) =>
  `document.querySelector('${LEDGER} [data-ledger-group="${group}"] [data-ledger-entry][data-pin="${pin}"]') !== null`;
const ISSUES = '[data-live="issue-graph"]';
const LAPS_QUERIES = ['lanes', 'recent-laps'] as const;
const LANE = '[data-live="lanes"] [data-lane]';
const RECENT_LAP = '[data-live="recent-laps"] [data-recent-lap]';
const laneOn = (runId: string, step: string) =>
  `document.querySelector('[data-live="lanes"] [data-lane="${runId}"]')?.getAttribute('data-step') === '${step}'`;
const DIFF = '[data-live="arch-diff"]';
const FEATURE_TIMEOUT_MS = 10_000;
/** How long to wait for `ready` before giving up; the limit is judged on the page's own marks. */
export const READY_WAIT_MS = 10_000;

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

export async function freePort(): Promise<number> {
  for (let port = SERVE_PORTS.min; port <= SERVE_PORTS.max; port++) {
    try {
      Bun.listen({ hostname: '127.0.0.1', port, socket: { data() {} } }).stop(true);
      return port;
    } catch {}
  }
  throw new Error(`no free port in ${SERVE_PORTS.min}-${SERVE_PORTS.max}`);
}

export async function waitForHealth(base: string, exited: () => boolean): Promise<void> {
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
export function pageWait(condition: string, ms: number): string {
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

export const markTime = (name: string) =>
  `performance.getEntriesByName('${name}')[0]?.startTime ?? null`;

/** When `query`'s panel was ready after navigation, and after its subscribe was sent (#13). */
async function panelMarks(
  page: Page,
  query: string,
): Promise<{ readyMs: number | null; firstSnapshotMs: number | null }> {
  const readyAt = await page.evaluate<number | null>(markTime(`live:${query}:ready`));
  const subscribedAt = await page.evaluate<number | null>(markTime(`live:${query}:subscribe-sent`));
  return {
    readyMs: readyAt === null ? null : Math.round(readyAt),
    firstSnapshotMs:
      readyAt === null || subscribedAt === null ? null : Math.round(readyAt - subscribedAt),
  };
}

/**
 * One panel's timings. `readyMs` is from navigation (connection setup to Neon included);
 * `firstSnapshotMs` is from the panel's subscribe being sent, once Realtime said `ready` on its
 * socket, to its rows on screen (owner decision on #13). The strip's inserts are running laps;
 * the map's are `fixture:write step` events, timed from starting the command.
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

/**
 * Running laps per map node for `factory`, straight from the laps tables. Archon names a nested
 * step by its path joined with `__`, and a node counts the laps on it or anywhere beneath it.
 */
async function lapsOnNodes(db: Db, factory: string): Promise<(path: string) => number> {
  const running = await db.query(
    `SELECT ls.run_id, ls.step_id
       FROM mc.lap_steps ls JOIN mc.laps l ON l.run_id = ls.run_id
      WHERE l.factory = $1 AND l.workflow_name = 'archon-loop' AND l.status = 'running'
        AND ls.status = 'running'`,
    [factory],
  );
  return (path) => {
    const key = path.replaceAll('/', '__');
    const on = running.filter((r) => {
      const step = String(r.step_id);
      return step === key || step.startsWith(`${key}__`);
    });
    return new Set(on.map((r) => String(r.run_id))).size;
  };
}

/** Where the map, in document order, differs from the seed and from `lapsOn`: one line each. */
function mapMismatches(nodes: ShownNode[], lapsOn: (path: string) => number): string[] {
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
    const expected = lapsOn(node.step ?? '');
    if (Number(node.count) !== expected) {
      failures.push(`${node.step} shows ${node.count} laps, the database has ${expected}`);
    }
  }
  return failures;
}

/** Runs `fixture:write step` on `runId` and times it to LIVE_STEP's count reaching `target`. */
const stepToScreen = (page: Page, deps: Deps, runId: string, target: number) =>
  writeToScreen(
    page,
    deps,
    ['step', '--run', runId, '--step', LIVE_STEP, '--event', 'node_started'],
    `${liveCountOf(LIVE_STEP)} === '${target}'`,
  );

/** Inserts one running lap and times it from just before the insert to the strip showing it. */
export async function insertToScreen(
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
  /** Per query, from the panel's subscribe being sent to its first rows. */
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

export const renewalsOf = (query: string) =>
  `performance.getEntriesByName('live:${query}:renewed').length`;

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
  const expected = { scorecard: `/f/${factory}/scorecard`, diff: `/f/${factory}/diff` };
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

interface ArchDiffTimings {
  branch: string | null;
  port: number | null;
  url: string | null;
  shown: string[] | null;
  readyMs: number | null;
  firstSnapshotMs: number | null;
  stepToScreenMs: number | null;
  holdSeconds: number;
  renewals: number | null;
  afterHoldStepToScreenMs: number | null;
  noReload: boolean | null;
  limits: typeof LIMITS;
}

/** The seed's V1 to V2 (V2_EDITS in scripts/fixture/seed-architecture.ts) as the diff lists it. */
const SEED_ARCH_CHANGE = [
  'added step archon-loop · tally',
  'removed step archon-loop · briefs',
  'changed prompt loop/commands/loop-review.md',
  'changed subagent archon-manager · manage · holdout-writer',
];

const changesOnScreen = `[...document.querySelectorAll('${DIFF} [data-change]')].map((li) => [
  li.getAttribute('data-change'),
  li.closest('[data-kind]')?.getAttribute('data-kind'),
  li.getAttribute('data-item'),
].join(' '))`;

type ArchKey = { archon_sha: string; factory_sha: string };

/** The architecture rows `db/queries/arch-diff.sql` reads for one of the factory's versions. */
async function archOf(db: Db, factory: string, digest: string): Promise<ArchKey> {
  const [version] = await db.query(
    `SELECT a.archon_sha, a.factory_sha FROM mc.arch_versions a
     WHERE a.archon_sha = (
       SELECT p.archon_sha FROM mc.pins p
       WHERE p.committed_at < (
         SELECT min(started_at) FROM mc.laps WHERE factory = $1 AND digest = $2)
       ORDER BY p.committed_at DESC LIMIT 1)
     ORDER BY a.parsed_at DESC LIMIT 1`,
    [factory, digest],
  );
  if (version === undefined) throw new Error(`no architecture is recorded for ${digest}`);
  return { archon_sha: String(version.archon_sha), factory_sha: String(version.factory_sha) };
}

/** Inserts one step into `arch` and times it from just before the insert to the diff adding it. */
async function archStepToScreen(
  page: Page,
  db: Db,
  arch: ArchKey,
  added: string[],
): Promise<number | null> {
  const path = `live-${crypto.randomUUID().slice(0, 8)}`;
  const selector = `${DIFF} [data-change="added"][data-item="archon-loop · ${path}"]`;
  const started = performance.now();
  const shown = page.evaluate<boolean>(
    pageWait(
      `document.querySelector(${JSON.stringify(selector)}) !== null`,
      LIMITS.insertToScreenMs,
    ),
    LIMITS.insertToScreenMs + 5000,
  );
  added.push(path);
  await db.query(
    `INSERT INTO mc.arch_steps
       (archon_sha, factory_sha, workflow, path, position, step_id, kind, bash, defined_in, file)
     VALUES ($1, $2, 'archon-loop', $3, 10000, $3, 'bash', 'echo live', 'archon-loop',
       'loop/archon-loop.yaml')`,
    [arch.archon_sha, arch.factory_sha, path],
  );
  return (await shown) ? Math.round(performance.now() - started) : null;
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

/**
 * Runs `fixture:write <args>` and times it from just before the spawn to `condition` holding on
 * the page.
 */
async function writeToScreen(
  page: Page,
  deps: Deps,
  args: readonly string[],
  condition: string,
): Promise<number | null> {
  const started = performance.now();
  const shown = page.evaluate<boolean>(
    pageWait(condition, LIMITS.insertToScreenMs),
    LIMITS.insertToScreenMs + 5000,
  );
  const write = Bun.spawn(['bun', 'run', 'fixture:write', ...args], {
    cwd: deps.repoRoot,
    env: deps.env,
    stdout: 'ignore',
    stderr: 'inherit',
  });
  const exitCode = await write.exited;
  if (exitCode !== 0) {
    await shown;
    throw new Error(`bun run fixture:write ${args.join(' ')} exited ${exitCode}`);
  }
  return (await shown) ? Math.round(performance.now() - started) : null;
}

const entriesAre = (target: number) => `document.querySelectorAll('${ENTRY}').length === ${target}`;

interface ScorecardTimings {
  branch: string | null;
  port: number | null;
  readyMs: number | null;
  firstSnapshotMs: number | null;
  mergeToScreenMs: number | null;
  holdSeconds: number;
  renewals: number | null;
  afterHoldMergeToScreenMs: number | null;
  noReload: boolean | null;
  limits: typeof LIMITS;
}

/** One number on the scorecard: its attributes, the laps it lists, and its summary's text. */
export interface ShownCell {
  digest: string | null;
  measure: string | null;
  value: string | null;
  laps: string | null;
  listed: number;
  summary: string | null;
}

const cellsOnScreen = `[...document.querySelectorAll('${SCORECARD} [data-version][data-measure]')].map((cell) => ({
  digest: cell.getAttribute('data-digest'),
  measure: cell.getAttribute('data-measure'),
  value: cell.getAttribute('data-value'),
  laps: cell.getAttribute('data-laps'),
  listed: cell.querySelectorAll('[data-lap]').length,
  summary: cell.querySelector('summary')?.textContent ?? null,
}))`;

interface ExpectedScorecard {
  versions: { digest: string; measures: Record<string, { value: number | null; laps: number }> }[];
}

interface ScorecardComparison {
  digest: string;
  measure: string;
  screen: { value: number | null; laps: number } | null;
  expected: { value: number | null; laps: number };
  match: boolean;
}

/**
 * Every measure of every version in `fixtures/expected-scorecard.json` against the cell the
 * screen shows for it; a number the screen does not show is a mismatch. Also each cell whose lap
 * list or summary disagrees with its `data-laps`.
 */
export function compareScorecard(
  shown: readonly ShownCell[],
  expected: ExpectedScorecard,
): { comparisons: ScorecardComparison[]; mismatches: number; lapListFailures: string[] } {
  const comparisons = expected.versions.flatMap(({ digest, measures }) =>
    Object.entries(measures).map(([measure, want]): ScorecardComparison => {
      const cell = shown.find((c) => c.digest === digest && c.measure === measure);
      const screen =
        cell === undefined
          ? null
          : { value: cell.value === 'n/a' ? null : Number(cell.value), laps: Number(cell.laps) };
      const match = screen !== null && screen.value === want.value && screen.laps === want.laps;
      return { digest, measure, screen, expected: want, match };
    }),
  );
  const lapListFailures = shown.flatMap((cell) => {
    const laps = Number(cell.laps);
    const summary = Number(/^\d+/.exec(cell.summary ?? '')?.[0]);
    return cell.listed === laps && summary === laps
      ? []
      : [
          `${cell.digest} ${cell.measure}: data-laps ${cell.laps}, lists ${cell.listed}, summary "${cell.summary}"`,
        ];
  });
  return {
    comparisons,
    mismatches: comparisons.filter((c) => !c.match).length,
    lapListFailures,
  };
}

/** Opens the scorecard of `a` against `b` and waits for it to be ready. */
async function openScorecard(deps: Deps, base: string, factory: string, a: string, b: string) {
  const page = await openPage(deps.env);
  await page.goto(
    `${base}/f/${factory}/scorecard?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`,
  );
  await page.evaluate('window.__mcNoReload = true');
  const ready = await page.evaluate<boolean>(
    pageWait(`document.querySelector('${SCORECARD}[data-state="ready"]') !== null`, READY_WAIT_MS),
  );
  if (!ready) {
    await page.close();
    throw new Error(`the scorecard did not reach data-state="ready" within ${READY_WAIT_MS} ms`);
  }
  return page;
}

/** Each difference's `data-meaningful` and whether it carries the `not yet meaningful` label. */
const differencesOnScreen = `[...document.querySelectorAll('${SCORECARD} [data-difference]')].map((d) => ({
  meaningful: d.getAttribute('data-meaningful'),
  labelled: d.textContent.includes('not yet meaningful'),
}))`;

async function labelFailures(page: Page, pair: string, meaningful: boolean): Promise<string[]> {
  const shown =
    await page.evaluate<{ meaningful: string | null; labelled: boolean }[]>(differencesOnScreen);
  if (shown.length === 0) return [`${pair} shows no differences`];
  return shown
    .filter((d) => d.meaningful !== String(meaningful) || d.labelled === meaningful)
    .map(
      (d) =>
        `${pair}: a difference has data-meaningful=${d.meaningful}${d.labelled ? ' and is' : ' and is not'} labelled not yet meaningful`,
    );
}

/** V2's merges on the open scorecard (version b) equal `target`. */
const mergesAre = (target: number) =>
  `document.querySelector('${SCORECARD} [data-version="b"][data-measure="merges"]')?.getAttribute('data-value') === '${target.toFixed(4)}'`;

type PerQuery = Record<(typeof DECISION_QUERIES)[number], number | null>;

interface DecisionsTimings {
  branch: string | null;
  port: number | null;
  /** Navigation to the later of the two panels reaching `data-state="ready"`. */
  readyMs: number | null;
  /** Per live query: its subscribe being sent to its first snapshot (owner decision, #13). */
  firstSnapshotMs: PerQuery;
  verdictToScreenMs: number | null;
  decisionToScreenMs: number | null;
  holdSeconds: number;
  renewals: PerQuery;
  afterHoldVerdictToScreenMs: number | null;
  afterHoldDecisionToScreenMs: number | null;
  noReload: boolean | null;
  limits: typeof LIMITS;
}

interface IssueGraphTimings {
  branch: string | null;
  port: number | null;
  readyMs: number | null;
  firstSnapshotMs: number | null;
  /** The issue `fixture:write label` labelled, and how long its node took to show it. */
  labelToScreen: { issue: number; ms: number | null } | null;
  holdSeconds: number;
  renewals: number | null;
  afterHoldLabelToScreen: { issue: number; ms: number | null } | null;
  noReload: boolean | null;
  limits: typeof LIMITS;
}

interface ShownDecision {
  date: string | null;
  title: string | null;
  link: string | null;
  href: string | null;
}

interface ShownLedgerEntry {
  group: string | null;
  pin: string | null;
  laps: string | null;
  waiting: string | null;
  verdict: string | null;
  sentence: string | null;
}

const decisionsOnScreen = `[...document.querySelectorAll('${DECISION}')].map((li) => ({
  date: li.getAttribute('data-date'),
  title: li.getAttribute('data-title'),
  link: li.querySelector('[data-version-link]')?.getAttribute('data-version-link') ?? null,
  href: li.querySelector('[data-version-link]')?.getAttribute('href') ?? null,
}))`;

const ledgerOnScreen = `[...document.querySelectorAll('${LEDGER} [data-ledger-entry]')].map((li) => ({
  group: li.closest('[data-ledger-group]')?.getAttribute('data-ledger-group') ?? null,
  pin: li.getAttribute('data-pin'),
  laps: li.getAttribute('data-laps'),
  waiting: li.getAttribute('data-waiting'),
  verdict: li.getAttribute('data-verdict'),
  sentence: li.getAttribute('data-sentence'),
}))`;

/** V2's laps still waiting, computed apart from the live query: its laps come from mc.versions. */
const V2_WAITING_SQL = `SELECT p.sha, substring(p.measure from 'at least ([0-9]+)')::int AS wanted, n.laps,
  greatest(0, substring(p.measure from 'at least ([0-9]+)')::int - n.laps) AS waiting
FROM mc.pins p, (
  SELECT count(*)::int AS laps FROM mc.laps l
  JOIN mc.versions v ON v.factory = l.factory AND v.digest = l.digest
  WHERE l.factory = $1 AND l.workflow_name = 'archon-loop' AND v.pin_sha = $2
) n
WHERE p.sha = $2`;

/**
 * The decisions screen against the seed, read before anything is written: the timeline is the
 * seed's decisions in date order with the joined ones linked to the versions screen, V2 waits for
 * the laps V2_WAITING_SQL computes, and V1 shows `helped` with its sentence.
 */
async function seedDecisionMismatches(
  page: Page,
  db: Db,
  factory: string,
): Promise<{ mismatches: string[]; report: string; v2: string }> {
  const decisions = await page.evaluate<ShownDecision[]>(decisionsOnScreen);
  const ledgerShown = await page.evaluate<ShownLedgerEntry[]>(ledgerOnScreen);
  const seedDecisions = await db.query(
    `SELECT d.date::text AS date, d.title, d.version,
       (SELECT p.sha FROM mc.pins p WHERE p.sha LIKE d.version || '%') AS pin_sha
     FROM mc.decisions d ORDER BY d.date, d.title`,
  );
  const pins = await db.query('SELECT sha FROM mc.pins ORDER BY committed_at');
  const [v1, v2] = pins.map((p) => String(p.sha));
  const [v2Sql] = await db.query(V2_WAITING_SQL, [factory, v2]);
  const [v1Verdict] = await db.query(
    `SELECT verdict, sentence FROM mc.verdicts WHERE $1 LIKE pin || '%' ORDER BY committed_at DESC LIMIT 1`,
    [v1],
  );

  const mismatches: string[] = [];
  if (decisions.length !== seedDecisions.length) {
    mismatches.push(
      `the timeline shows ${decisions.length} entries, the seed has ${seedDecisions.length}`,
    );
  }
  seedDecisions.forEach((seed, i) => {
    const shown = decisions[i];
    const pin = seed.pin_sha === null ? null : String(seed.pin_sha);
    const expected: ShownDecision = {
      date: String(seed.date),
      title: String(seed.title),
      link: pin,
      href: pin === null ? null : `/f/${factory}/versions`,
    };
    for (const key of Object.keys(expected) as (keyof ShownDecision)[]) {
      if (shown?.[key] !== expected[key]) {
        mismatches.push(`decision ${i + 1} ${key}: screen ${shown?.[key]}, seed ${expected[key]}`);
      }
    }
  });
  const joined = decisions.flatMap((d) => (d.link === null ? [] : [d.link]));
  if (joined.length !== 2 || !joined.includes(v1) || !joined.includes(v2)) {
    mismatches.push(`the joined decisions link to ${joined.join(', ')}, expected V1 and V2`);
  }
  const v2Shown = ledgerShown.find((e) => e.pin === v2);
  if (v2Shown?.group !== 'testing') {
    mismatches.push(`V2 is under ${v2Shown?.group ?? 'nothing'}, expected testing`);
  }
  if (v2Sql?.waiting === null || v2Shown?.waiting !== String(v2Sql?.waiting)) {
    mismatches.push(`V2 waits for ${v2Shown?.waiting} laps on screen, ${v2Sql?.waiting} by SQL`);
  }
  const v1Shown = ledgerShown.find((e) => e.pin === v1);
  if (
    v1Shown?.group !== 'verdicts' ||
    v1Shown.verdict !== 'helped' ||
    v1Verdict?.verdict !== 'helped' ||
    v1Shown.sentence !== v1Verdict?.sentence
  ) {
    mismatches.push(
      `V1 shows ${JSON.stringify(v1Shown)}, expected verdicts, helped, ${JSON.stringify(v1Verdict)}`,
    );
  }
  const report = [
    'timeline on screen:',
    ...decisions.map((d) => `  ${JSON.stringify(d)}`),
    'seed decisions by date (mc.decisions, version joined to mc.pins by prefix):',
    ...seedDecisions.map((d) => `  ${JSON.stringify(d)}`),
    'ledger on screen:',
    ...ledgerShown.map((e) => `  ${JSON.stringify(e)}`),
    `V1 = ${v1}, V2 = ${v2} (seed pins by commit)`,
    `V2 laps waiting by SQL ($1 = ${factory}, $2 = V2):`,
    ...V2_WAITING_SQL.split('\n').map((line) => `  ${line}`),
    `  -> ${JSON.stringify(v2Sql)}`,
    `V2 laps waiting on screen: ${v2Shown?.waiting ?? 'absent'}`,
    `V1 verdict in mc.verdicts: ${JSON.stringify(v1Verdict)}`,
    ...mismatches,
    `mismatches: ${mismatches.length}`,
  ].join('\n');
  return { mismatches, report, v2 };
}

interface IssuesOnScreen {
  issues: { number: number; state: string; chain: boolean; dot: string; token: string | null }[];
  dependencies: string[];
  phases: { phase: string; merged: number; total: number }[];
}

const issuesOnScreen = `(() => {
  const tokens = ${JSON.stringify(STATE_TOKEN)};
  const token = (name) => {
    if (name === undefined) return null;
    const probe = document.body.appendChild(document.createElement('span'));
    probe.style.backgroundColor = 'var(' + name + ')';
    const color = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return color;
  };
  return {
    issues: [...document.querySelectorAll('${ISSUES} [data-issue]')].map((a) => ({
      number: Number(a.getAttribute('data-issue')),
      state: a.getAttribute('data-issue-state'),
      chain: a.getAttribute('data-longest-chain') === 'true',
      dot: getComputedStyle(a.querySelector('[data-state-dot]')).backgroundColor,
      token: token(tokens[a.getAttribute('data-issue-state')]),
    })),
    dependencies: [...document.querySelectorAll('${ISSUES} [data-dependency]')].map((p) =>
      p.getAttribute('data-dependency'),
    ),
    phases: [...document.querySelectorAll('${ISSUES} [data-phase]')].map((li) => ({
      phase: li.getAttribute('data-phase'),
      merged: Number(li.getAttribute('data-merged')),
      total: Number(li.getAttribute('data-total')),
    })),
  };
})()`;

/** Every open chain of `Depends on` edges through open issues, longest first. */
const OPEN_CHAINS_SQL = `WITH RECURSIVE open AS (
    SELECT number FROM mc.issues WHERE factory = $1 AND state = 'open'
  ), chain(tail, path) AS (
    SELECT number, ARRAY[number] FROM open
    UNION ALL
    SELECT d.depends_on, c.path || d.depends_on FROM chain c
    JOIN mc.issue_dependencies d ON d.factory = $1 AND d.issue_number = c.tail
    JOIN open o ON o.number = d.depends_on
    WHERE NOT d.depends_on = ANY(c.path)
  )
  SELECT path FROM chain ORDER BY cardinality(path) DESC`;

/** The issues screen against SQL on the seed, read before any label is written. */
async function seedIssueGraphMismatches(
  page: Page,
  db: Db,
  factory: string,
  liveSql: string,
): Promise<{ mismatches: string[]; report: string }> {
  const shown = await page.evaluate<IssuesOnScreen>(issuesOnScreen);
  const mismatches: string[] = [];
  const same = (what: string, screen: unknown, sql: unknown) => {
    if (JSON.stringify(screen) !== JSON.stringify(sql)) {
      mismatches.push(`${what}: screen ${JSON.stringify(screen)}, SQL ${JSON.stringify(sql)}`);
    }
  };

  const issues = await db.query('SELECT number FROM mc.issues WHERE factory = $1 ORDER BY number', [
    factory,
  ]);
  same(
    'nodes',
    shown.issues.map((i) => i.number).sort((a, b) => a - b),
    issues.map((i) => Number(i.number)),
  );
  const edges = await db.query(
    'SELECT issue_number, depends_on FROM mc.issue_dependencies WHERE factory = $1 ORDER BY 1, 2',
    [factory],
  );
  const byNumbers = (a: string, b: string) => {
    const [a1, a2] = a.split('-').map(Number);
    const [b1, b2] = b.split('-').map(Number);
    return a1 - b1 || a2 - b2;
  };
  same(
    'edges',
    [...shown.dependencies].sort(byNumbers),
    edges.map((e) => `${e.issue_number}-${e.depends_on}`),
  );

  const states = (await db.query(liveSql, [factory]))
    .filter((r) => r.kind === 'issue')
    .map((r) => `#${r.number} ${r.state}`)
    .sort();
  same('states', shown.issues.map((i) => `#${i.number} ${i.state}`).sort(), states);
  for (const state of ISSUE_STATES) {
    if (!shown.issues.some((i) => i.state === state)) mismatches.push(`no node is ${state}`);
  }
  for (const i of shown.issues) {
    if (i.token === null || i.dot !== i.token) {
      mismatches.push(`#${i.number} ${i.state} is colored ${i.dot}, its token is ${i.token}`);
    }
  }

  const phases = await db.query(
    `SELECT i.phase, count(*)::int AS total,
       count(*) FILTER (WHERE i.state = 'closed' AND EXISTS (
         SELECT 1 FROM mc.pull_request_issues pi
         JOIN mc.pull_requests p ON p.factory = pi.factory AND p.number = pi.pr_number
         WHERE pi.factory = i.factory AND pi.issue_number = i.number AND p.merged_at IS NOT NULL
       ))::int AS merged
     FROM mc.issues i WHERE i.factory = $1 AND i.phase IS NOT NULL
     GROUP BY i.phase ORDER BY min(i.number)`,
    [factory],
  );
  same(
    'phase bars',
    shown.phases,
    phases.map((p) => ({ phase: p.phase, merged: p.merged, total: p.total })),
  );

  // An int[] arrives as an Int32Array, which JSON would print as an object.
  const chains = (await db.query(OPEN_CHAINS_SQL, [factory])).map((r) =>
    Array.from(r.path as ArrayLike<number>, Number),
  );
  const longest = chains.filter((c) => c.length === chains[0]?.length);
  if (longest.length !== 1 || longest[0].length < 3) {
    mismatches.push(
      `the seed must have one longest open chain of at least 3, it has ${JSON.stringify(longest)}`,
    );
  }
  same(
    'longest open chain',
    shown.issues
      .filter((i) => i.chain)
      .map((i) => i.number)
      .sort((a, b) => a - b),
    [...(longest[0] ?? [])].sort((a, b) => a - b),
  );

  const report = [
    'screen:',
    `  ${JSON.stringify(shown)}`,
    'SQL (mc.issues, mc.issue_dependencies, db/queries/issue-graph.sql, phase counts, open chains):',
    `  nodes ${JSON.stringify(issues.map((i) => i.number))}`,
    `  edges ${JSON.stringify(edges.map((e) => `${e.issue_number}-${e.depends_on}`))}`,
    `  states ${JSON.stringify(states)}`,
    `  phases ${JSON.stringify(phases)}`,
    `  longest open chains ${JSON.stringify(longest)}`,
    ...mismatches,
    `mismatches: ${mismatches.length}`,
  ].join('\n');
  return { mismatches, report };
}

/**
 * Runs `fixture:write label`, which labels the highest-numbered open issue without `needs-owner`,
 * and times it from just before the spawn to that issue's node reading `needs-owner`.
 */
async function labelToScreen(
  page: Page,
  db: Db,
  deps: Deps,
  factory: string,
  labelled: number[],
): Promise<{ issue: number; ms: number | null }> {
  const [target] = await db.query(NEXT_TO_LABEL, [factory]);
  if (!target) throw new Error(`no open ${factory} issue for fixture:write label to label`);
  const issue = Number(target.number);
  const node = `${ISSUES} [data-issue="${issue}"]`;
  const before = await page.evaluate<string | null>(
    `document.querySelector('${node}')?.getAttribute('data-issue-state') ?? null`,
  );
  if (before !== 'waiting') {
    throw new Error(`fixture:write label will label #${issue}, which is ${before}, not waiting`);
  }
  const started = performance.now();
  const shown = page.evaluate<boolean>(
    pageWait(
      `document.querySelector('${node}')?.getAttribute('data-issue-state') === 'needs-owner'`,
      LIMITS.insertToScreenMs,
    ),
    LIMITS.insertToScreenMs + 5000,
  );
  labelled.push(issue);
  const write = Bun.spawn(['bun', 'run', 'fixture:write', 'label'], {
    cwd: deps.repoRoot,
    env: deps.env,
    stdout: 'ignore',
    stderr: 'inherit',
  });
  const exitCode = await write.exited;
  if (exitCode !== 0) {
    await shown;
    throw new Error(`bun run fixture:write label exited ${exitCode}`);
  }
  return { issue, ms: (await shown) ? Math.round(performance.now() - started) : null };
}

type PerLapsQuery = Record<(typeof LAPS_QUERIES)[number], number | null>;

interface LapsTimings {
  branch: string | null;
  port: number | null;
  /** Navigation to the later of the two panels reaching `data-state="ready"`. */
  readyMs: number | null;
  /** Per live query: its subscribe being sent to its first snapshot (owner decision, #13). */
  firstSnapshotMs: PerLapsQuery;
  /** The lap `fixture:write step --step review --event node_started` ran on, and its lane's time. */
  stepToLane: { run: string; ms: number | null } | null;
  holdSeconds: number;
  renewals: PerLapsQuery;
  afterHoldStepToLane: { run: string; ms: number | null } | null;
  noReload: boolean | null;
  limits: typeof LIMITS;
}

/** Starts timing `condition` on `page` now; resolves to its milliseconds, or null past the limit. */
function untilShown(page: Page, condition: string): Promise<number | null> {
  const started = performance.now();
  return page
    .evaluate<boolean>(pageWait(condition, LIMITS.insertToScreenMs), LIMITS.insertToScreenMs + 5000)
    .then((shown) => (shown ? Math.round(performance.now() - started) : null));
}

interface LapsOnScreen {
  lanes: {
    run: string;
    issue: number | null;
    route: string | null;
    depth: string | null;
    step: string | null;
    cost: number;
  }[];
  recent: {
    run: string;
    outcome: string | null;
    cost: number;
    dot: string;
    token: string | null;
  }[];
}

const lapsOnScreen = `(() => {
  const tokens = ${JSON.stringify(OUTCOME_TOKEN)};
  const token = (name) => {
    if (name === undefined) return null;
    const probe = document.body.appendChild(document.createElement('span'));
    probe.style.backgroundColor = 'var(' + name + ')';
    const color = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return color;
  };
  const num = (el, name) => (el.hasAttribute(name) ? Number(el.getAttribute(name)) : null);
  return {
    lanes: [...document.querySelectorAll('${LANE}')].map((li) => ({
      run: li.getAttribute('data-lane'),
      issue: num(li, 'data-issue'),
      route: li.getAttribute('data-route'),
      depth: li.getAttribute('data-depth'),
      step: li.getAttribute('data-step'),
      cost: Number(li.getAttribute('data-cost')),
    })),
    recent: [...document.querySelectorAll('${RECENT_LAP}')].map((li) => ({
      run: li.getAttribute('data-recent-lap'),
      outcome: li.getAttribute('data-outcome'),
      cost: Number(li.getAttribute('data-cost')),
      dot: getComputedStyle(li.querySelector('[data-outcome-dot]')).backgroundColor,
      token: token(tokens[li.getAttribute('data-outcome')]),
    })),
  };
})()`;

/**
 * The laps screen against SQL over the seed's tables (not the screen's queries) and against the
 * seed's own account of each lap, read before any lap is inserted or step written.
 */
async function seedLapsMismatches(
  page: Page,
  db: Db,
  factory: string,
  seed: string,
): Promise<{ mismatches: string[]; report: string }> {
  const shown = await page.evaluate<LapsOnScreen>(lapsOnScreen);
  const mismatches: string[] = [];
  const same = (what: string, screen: unknown, sql: unknown) => {
    if (JSON.stringify(screen) !== JSON.stringify(sql)) {
      mismatches.push(`${what}: screen ${JSON.stringify(screen)}, SQL ${JSON.stringify(sql)}`);
    }
  };
  const byRun = <T extends { run: string }>(rows: readonly T[]) =>
    [...rows].sort((a, b) => a.run.localeCompare(b.run));

  const running = await db.query(
    `SELECT l.run_id::text AS run,
       (SELECT c.issue_number FROM mc.claims c
         WHERE c.factory = l.factory AND c.run_id = l.run_id AND c.released_at IS NULL) AS issue,
       pick.output ->> 'route' AS route,
       pick.output ->> 'depth' AS depth,
       (SELECT s.step_id FROM mc.lap_steps s WHERE s.run_id = l.run_id AND s.status = 'running') AS step,
       (SELECT coalesce(sum(s.cost_usd), 0)::float8 FROM mc.lap_steps s WHERE s.run_id = l.run_id) AS cost
     FROM mc.laps l
     LEFT JOIN mc.lap_steps pick ON pick.run_id = l.run_id AND pick.step_id = 'pick'
     WHERE l.factory = $1 AND l.workflow_name = 'archon-loop' AND l.status = 'running'
     ORDER BY 1`,
    [factory],
  );
  const lanesSql = running.map((r) => ({
    run: String(r.run),
    issue: r.issue === null ? null : Number(r.issue),
    route: r.route,
    depth: r.depth,
    step: r.step,
    cost: Number(r.cost),
  }));
  if (lanesSql.length !== 2) mismatches.push(`the seed has ${lanesSql.length} running laps, not 2`);
  same('lanes', byRun(shown.lanes), lanesSql);

  const laps = seedLaps(seed);
  const seedRunning = laps
    .filter((l) => l.what === 'running')
    .map((l) => ({ run: l.runId, issue: l.issue }));
  same(
    'lanes against the seed',
    byRun(shown.lanes.map((l) => ({ run: l.run, issue: l.issue }))),
    byRun(seedRunning),
  );

  const finished = await db.query(
    `SELECT l.run_id::text AS run,
       (SELECT coalesce(sum(s.cost_usd), 0)::float8 FROM mc.lap_steps s WHERE s.run_id = l.run_id) AS cost
     FROM mc.laps l
     WHERE l.factory = $1 AND l.workflow_name = 'archon-loop'
       AND l.status IN ('completed', 'failed', 'cancelled')
     ORDER BY 1`,
    [factory],
  );
  const finishedSql = finished.map((r) => ({ run: String(r.run), cost: Number(r.cost) }));
  same(
    'finished laps and their cost',
    byRun(shown.recent.map((l) => ({ run: l.run, cost: l.cost }))),
    finishedSql,
  );
  const seedFinished = laps.filter((l) => !['running', 'paused', 'pending'].includes(l.what));
  same(
    'outcomes against the seed',
    byRun(shown.recent.map((l) => ({ run: l.run, outcome: l.outcome }))),
    byRun(seedFinished.map((l) => ({ run: l.runId, outcome: l.what }))),
  );
  for (const outcome of OUTCOMES) {
    if (!shown.recent.some((l) => l.outcome === outcome)) {
      mismatches.push(`no finished lap shows ${outcome}`);
    }
  }
  for (const lap of shown.recent) {
    if (lap.token === null || lap.dot !== lap.token) {
      mismatches.push(`${lap.run} ${lap.outcome} is colored ${lap.dot}, its token is ${lap.token}`);
    }
  }

  const tally = Object.fromEntries(
    OUTCOMES.map((o) => [o, shown.recent.filter((l) => l.outcome === o).length]),
  );
  const report = [
    'screen:',
    `  lanes ${JSON.stringify(byRun(shown.lanes))}`,
    `  recent ${JSON.stringify(byRun(shown.recent))}`,
    'SQL (mc.laps, mc.claims, mc.lap_steps; not the queries in db/queries/):',
    `  lanes ${JSON.stringify(lanesSql)}`,
    `  finished ${JSON.stringify(finishedSql)}`,
    'seed (fixtures/seed.sql, the comment above each run):',
    `  running ${JSON.stringify(byRun(seedRunning))}`,
    `  finished ${JSON.stringify(seedFinished.map((l) => ({ run: l.runId, label: l.label, outcome: l.what })))}`,
    `outcomes on screen: ${JSON.stringify(tally)}`,
    ...mismatches,
    `mismatches: ${mismatches.length}`,
  ].join('\n');
  return { mismatches, report };
}

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
  const scorecardTimings: ScorecardTimings = {
    branch: timings.branch,
    port: null,
    readyMs: null,
    firstSnapshotMs: null,
    mergeToScreenMs: null,
    holdSeconds,
    renewals: null,
    afterHoldMergeToScreenMs: null,
    noReload: null,
    limits: LIMITS,
  };
  const decisionTimings: DecisionsTimings = {
    branch: timings.branch,
    port: null,
    readyMs: null,
    firstSnapshotMs: { 'decisions-timeline': null, 'improvements-ledger': null },
    verdictToScreenMs: null,
    decisionToScreenMs: null,
    holdSeconds,
    renewals: { 'decisions-timeline': null, 'improvements-ledger': null },
    afterHoldVerdictToScreenMs: null,
    afterHoldDecisionToScreenMs: null,
    noReload: null,
    limits: LIMITS,
  };
  const issueTimings: IssueGraphTimings = {
    branch: timings.branch,
    port: null,
    readyMs: null,
    firstSnapshotMs: null,
    labelToScreen: null,
    holdSeconds,
    renewals: null,
    afterHoldLabelToScreen: null,
    noReload: null,
    limits: LIMITS,
  };
  const lapsTimings: LapsTimings = {
    branch: timings.branch,
    port: null,
    readyMs: null,
    firstSnapshotMs: { lanes: null, 'recent-laps': null },
    stepToLane: null,
    holdSeconds,
    renewals: { lanes: null, 'recent-laps': null },
    afterHoldStepToLane: null,
    noReload: null,
    limits: LIMITS,
  };
  let lapsPage: Page | undefined;
  const diffTimings: ArchDiffTimings = {
    branch: timings.branch,
    port: null,
    url: null,
    shown: null,
    readyMs: null,
    firstSnapshotMs: null,
    stepToScreenMs: null,
    holdSeconds,
    renewals: null,
    afterHoldStepToScreenMs: null,
    noReload: null,
    limits: LIMITS,
  };
  const labelled: number[] = [];
  const pinned: string[] = [];
  const addedSteps: string[] = [];
  let v2Arch: ArchKey | undefined;
  const judgedBy: string[] = [];
  const decided: string[] = [];
  const db = deps.openDb(databaseUrl);
  const rewind = rewindPhase({ deps, db, outDir, factory, holdSeconds });
  let server: ReturnType<typeof Bun.spawn> | undefined;
  let page: Page | undefined;
  let versionsPage: Page | undefined;
  let scorePage: Page | undefined;
  /** The `land` rows of the V2 laps the scorecard's writes land, as they were before them. */
  const landed: { runId: string; row: string | null }[] = [];
  let decisionsPage: Page | undefined;
  const latestVerdict = async () => {
    const [row] = await db.query('SELECT sha FROM mc.verdicts ORDER BY committed_at DESC LIMIT 1');
    judgedBy.push(String(row.sha));
  };
  const fixtureDecisions = async () =>
    (await db.query(`SELECT title FROM mc.decisions WHERE title LIKE 'Fixture decision %'`)).map(
      (row) => String(row.title),
    );
  const newDecisions = async (before: readonly string[]) => {
    for (const title of await fixtureDecisions()) {
      if (!before.includes(title) && !decided.includes(title)) decided.push(title);
    }
  };
  let issuesPage: Page | undefined;
  let diffPage: Page | undefined;
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
    mapTimings.port = port;
    versionTimings.port = port;
    scorecardTimings.port = port;
    decisionTimings.port = port;
    issueTimings.port = port;
    lapsTimings.port = port;
    diffTimings.port = port;
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
      const subscribedAt = await page.evaluate<number | null>(
        markTime(`live:${panel.query}:subscribe-sent`),
      );
      panel.timings.readyMs = readyAt === null ? null : Math.round(readyAt);
      panel.timings.firstSnapshotMs =
        readyAt === null || subscribedAt === null ? null : Math.round(readyAt - subscribedAt);
    }
    const before = Number(
      await page.evaluate<string>(
        `document.querySelector('${PANEL} [data-count]').getAttribute('data-count')`,
      ),
    );
    failures.push(...mapMismatches(await mapNodes(page), await lapsOnNodes(db, factory)));
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

    // The laps screen opens before the strip inserts its laps, so its lanes are the seed's two.
    lapsPage = await openPage(deps.env);
    await lapsPage.goto(`${base}/f/${factory}/laps`);
    await lapsPage.evaluate('window.__mcNoReload = true');
    const lapsReady = await lapsPage.evaluate<boolean>(
      pageWait(
        LAPS_QUERIES.map(
          (q) => `document.querySelector('[data-live="${q}"][data-state="ready"]') !== null`,
        ).join(' && '),
        READY_WAIT_MS,
      ),
    );
    if (!lapsReady) {
      throw new Error(
        `the laps screen did not reach data-state="ready" within ${READY_WAIT_MS} ms`,
      );
    }
    const lapsReadyMarks: number[] = [];
    for (const q of LAPS_QUERIES) {
      const readyAt = await lapsPage.evaluate<number | null>(markTime(`live:${q}:ready`));
      const subscribedAt = await lapsPage.evaluate<number | null>(
        markTime(`live:${q}:subscribe-sent`),
      );
      if (readyAt !== null) lapsReadyMarks.push(readyAt);
      lapsTimings.firstSnapshotMs[q] =
        readyAt === null || subscribedAt === null ? null : Math.round(readyAt - subscribedAt);
    }
    lapsTimings.readyMs =
      lapsReadyMarks.length === LAPS_QUERIES.length
        ? Math.round(Math.max(...lapsReadyMarks))
        : null;
    const lapsSeed = await seedLapsMismatches(
      lapsPage,
      db,
      factory,
      readFileSync(join(deps.repoRoot, 'fixtures', 'seed.sql'), 'utf-8'),
    );
    writeFileSync(join(outDir, 'lanes-check.txt'), `${lapsSeed.report}\n`);
    failures.push(...lapsSeed.mismatches.map((m) => `laps screen against the seed: ${m}`));
    writeFileSync(join(outDir, 'lanes-recent-laps.png'), await lapsPage.screenshot(1440));
    for (const lap of [firstLap, secondLap]) {
      if (await lapsPage.evaluate<boolean>(laneOn(lap, LIVE_STEP))) {
        throw new Error(`the lane of ${lap} is on ${LIVE_STEP} before any write`);
      }
    }

    timings.insertToScreenMs = await insertToScreen(page, db, inserted, factory, before + 1);
    deps.out(`first insert reached the strip in ${timings.insertToScreenMs ?? 'never'} ms`);
    written.push(firstLap);
    // The map's step write is the lanes' too: both screens watch the same event.
    const firstLane = untilShown(lapsPage, laneOn(firstLap, LIVE_STEP));
    mapTimings.insertToScreenMs = await stepToScreen(page, deps, firstLap, onLiveStep + 1);
    lapsTimings.stepToLane = { run: firstLap, ms: await firstLane };
    deps.out(
      `first step event reached the map in ${mapTimings.insertToScreenMs ?? 'never'} ms, its lane in ${lapsTimings.stepToLane.ms ?? 'never'} ms`,
    );

    decisionsPage = await openPage(deps.env);
    await decisionsPage.goto(`${base}/f/${factory}/decisions`);
    await decisionsPage.evaluate('window.__mcNoReload = true');
    const decisionsReady = await decisionsPage.evaluate<boolean>(
      pageWait(
        DECISION_QUERIES.map(
          (q) => `document.querySelector('[data-live="${q}"][data-state="ready"]') !== null`,
        ).join(' && '),
        READY_WAIT_MS,
      ),
    );
    if (!decisionsReady) {
      throw new Error(
        `the decisions screen did not reach data-state="ready" within ${READY_WAIT_MS} ms`,
      );
    }
    const readyMarks: number[] = [];
    for (const q of DECISION_QUERIES) {
      const readyAt = await decisionsPage.evaluate<number | null>(markTime(`live:${q}:ready`));
      const subscribedAt = await decisionsPage.evaluate<number | null>(
        markTime(`live:${q}:subscribe-sent`),
      );
      if (readyAt !== null) readyMarks.push(readyAt);
      decisionTimings.firstSnapshotMs[q] =
        readyAt === null || subscribedAt === null ? null : Math.round(readyAt - subscribedAt);
    }
    decisionTimings.readyMs =
      readyMarks.length === DECISION_QUERIES.length ? Math.round(Math.max(...readyMarks)) : null;
    const decisionSeed = await seedDecisionMismatches(decisionsPage, db, factory);
    writeFileSync(join(outDir, 'ledger-check.txt'), `${decisionSeed.report}\n`);
    failures.push(...decisionSeed.mismatches.map((m) => `decisions screen against the seed: ${m}`));
    writeFileSync(join(outDir, 'decisions-ledger.png'), await decisionsPage.screenshot(1440));

    const v2Pin = decisionSeed.v2;
    decisionTimings.verdictToScreenMs = await writeToScreen(
      decisionsPage,
      deps,
      ['verdict', '--pin', v2Pin.slice(0, 8)],
      `${inLedger('verdicts', v2Pin)} && !(${inLedger('testing', v2Pin)})`,
    );
    await latestVerdict();
    const timelineLength = await decisionsPage.evaluate<number>(
      `document.querySelectorAll('${DECISION}').length`,
    );
    const decisionsBefore = await fixtureDecisions();
    decisionTimings.decisionToScreenMs = await writeToScreen(
      decisionsPage,
      deps,
      ['decision'],
      `document.querySelectorAll('${DECISION}').length === ${timelineLength + 1}`,
    );
    await newDecisions(decisionsBefore);
    deps.out(
      `V2's verdict reached the ledger in ${decisionTimings.verdictToScreenMs ?? 'never'} ms, a decision the timeline in ${decisionTimings.decisionToScreenMs ?? 'never'} ms`,
    );

    stepPage = await openPage(deps.env);
    await openStep(stepPage, base, STEP_PATH, stepPanelsReady);
    await stepPage.evaluate('window.__mcNoReload = true');
    const stepReadyMarks: number[] = [];
    for (const query of STEP_QUERIES) {
      const readyAt = await stepPage.evaluate<number | null>(markTime(`live:${query}:ready`));
      const subscribedAt = await stepPage.evaluate<number | null>(
        markTime(`live:${query}:subscribe-sent`),
      );
      if (readyAt !== null) stepReadyMarks.push(readyAt);
      stepTimings.firstSnapshotMs[query] =
        readyAt === null || subscribedAt === null ? null : Math.round(readyAt - subscribedAt);
    }
    stepTimings.readyMs =
      stepReadyMarks.length === STEP_QUERIES.length
        ? Math.round(Math.max(...stepReadyMarks))
        : null;
    failures.push(...(await checkAppMismatches(stepPage, deps.repoRoot)));
    writeFileSync(join(outDir, 'step-detail.png'), await stepPage.screenshot(1440));
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
    Object.assign(versionTimings, await panelMarks(versionsPage, 'version-strip'));
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
    versionTimings.pinToScreenMs = await writeToScreen(
      versionsPage,
      deps,
      ['pin'],
      entriesAre(entries + 1),
    );
    await latestPin();
    deps.out(
      `first pin reached the versions screen in ${versionTimings.pinToScreenMs ?? 'never'} ms`,
    );

    const [, , v3] = seed.digests;
    scorePage = await openScorecard(deps, base, factory, v1, v2);
    Object.assign(scorecardTimings, await panelMarks(scorePage, 'scorecard'));
    const shown = await scorePage.evaluate<ShownCell[]>(cellsOnScreen);
    failures.push(...(await labelFailures(scorePage, 'V1 against V2', true)));
    const thinPage = await openScorecard(deps, base, factory, v1, v3);
    try {
      shown.push(...(await thinPage.evaluate<ShownCell[]>(cellsOnScreen)));
      failures.push(...(await labelFailures(thinPage, 'V1 against V3', false)));
    } finally {
      await thinPage.close();
    }
    const expected: ExpectedScorecard = JSON.parse(
      readFileSync(join(deps.repoRoot, 'fixtures', 'expected-scorecard.json'), 'utf-8'),
    );
    const compared = compareScorecard(shown, expected);
    writeFileSync(
      join(outDir, 'scorecard-vs-expected.json'),
      `${JSON.stringify({ branch: timings.branch, ...compared }, null, 2)}\n`,
    );
    failures.push(
      ...compared.comparisons
        .filter((c) => !c.match)
        .map(
          (c) =>
            `scorecard ${c.digest} ${c.measure}: screen ${JSON.stringify(c.screen)}, expected ${JSON.stringify(c.expected)}`,
        ),
      ...compared.lapListFailures.map((f) => `scorecard lap list: ${f}`),
    );
    writeFileSync(join(outDir, 'scorecard.png'), await scorePage.screenshot(1440));

    const unlanded = await db.query(
      `SELECT l.run_id, (SELECT to_jsonb(s)::text FROM mc.lap_steps s
         WHERE s.run_id = l.run_id AND s.step_id = 'land') AS row
       FROM mc.laps l
       WHERE l.factory = $1 AND l.digest = $2 AND NOT EXISTS (
         SELECT 1 FROM mc.lap_steps s WHERE s.run_id = l.run_id AND s.step_id = 'land'
           AND s.output ->> 'outcome' IN ('merged', 'refused'))
       ORDER BY l.started_at LIMIT 2`,
      [factory, v2],
    );
    if (unlanded.length < 2) {
      throw new Error(`the check branch has ${unlanded.length} V2 laps that did not land, not 2`);
    }
    const merges = Number(
      await scorePage.evaluate<string>(
        `document.querySelector('${SCORECARD} [data-version="b"][data-measure="merges"]').getAttribute('data-value')`,
      ),
    );
    const landToScreen = async (page: Page, target: number): Promise<number | null> => {
      const lap = unlanded[landed.length];
      landed.push({ runId: String(lap.run_id), row: lap.row === null ? null : String(lap.row) });
      const args = [
        'step',
        '--run',
        String(lap.run_id),
        '--step',
        'land',
        '--event',
        'node_completed',
      ];
      return writeToScreen(page, deps, args, mergesAre(target));
    };
    scorecardTimings.mergeToScreenMs = await landToScreen(scorePage, merges + 1);
    deps.out(
      `first merge reached the scorecard in ${scorecardTimings.mergeToScreenMs ?? 'never'} ms`,
    );

    issuesPage = await openPage(deps.env);
    await issuesPage.goto(`${base}/f/${factory}/issues`);
    await issuesPage.evaluate('window.__mcNoReload = true');
    const issuesReady = await issuesPage.evaluate<boolean>(
      pageWait(`document.querySelector('${ISSUES}[data-state="ready"]') !== null`, READY_WAIT_MS),
    );
    if (!issuesReady) {
      throw new Error(
        `the issues screen did not reach data-state="ready" within ${READY_WAIT_MS} ms`,
      );
    }
    const issuesReadyAt = await issuesPage.evaluate<number | null>(
      markTime('live:issue-graph:ready'),
    );
    const issuesSubscribedAt = await issuesPage.evaluate<number | null>(
      markTime('live:issue-graph:subscribe-sent'),
    );
    issueTimings.readyMs = issuesReadyAt === null ? null : Math.round(issuesReadyAt);
    issueTimings.firstSnapshotMs =
      issuesReadyAt === null || issuesSubscribedAt === null
        ? null
        : Math.round(issuesReadyAt - issuesSubscribedAt);
    const issueSeed = await seedIssueGraphMismatches(
      issuesPage,
      db,
      factory,
      readFileSync(join(deps.repoRoot, 'db', 'queries', 'issue-graph.sql'), 'utf-8'),
    );
    writeFileSync(join(outDir, 'issue-graph-check.txt'), `${issueSeed.report}\n`);
    failures.push(...issueSeed.mismatches.map((m) => `issues screen against the seed: ${m}`));
    writeFileSync(join(outDir, 'phases-issue-graph.png'), await issuesPage.screenshot(1440));
    issueTimings.labelToScreen = await labelToScreen(issuesPage, db, deps, factory, labelled);
    deps.out(
      `first label reached the issues screen in ${issueTimings.labelToScreen.ms ?? 'never'} ms`,
    );

    diffTimings.url = `/f/${factory}/diff?a=${encodeURIComponent(v1)}&b=${encodeURIComponent(v2)}`;
    diffPage = await openPage(deps.env);
    await diffPage.goto(`${base}${diffTimings.url}`);
    await diffPage.evaluate('window.__mcNoReload = true');
    const diffReady = await diffPage.evaluate<boolean>(
      pageWait(`document.querySelector('${DIFF}[data-state="ready"]') !== null`, READY_WAIT_MS),
    );
    if (!diffReady) {
      throw new Error(
        `the diff screen did not reach data-state="ready" within ${READY_WAIT_MS} ms`,
      );
    }
    const diffReadyAt = await diffPage.evaluate<number | null>(markTime('live:arch-diff:ready'));
    const diffSubscribedAt = await diffPage.evaluate<number | null>(
      markTime('live:arch-diff:subscribe-sent'),
    );
    diffTimings.readyMs = diffReadyAt === null ? null : Math.round(diffReadyAt);
    diffTimings.firstSnapshotMs =
      diffReadyAt === null || diffSubscribedAt === null
        ? null
        : Math.round(diffReadyAt - diffSubscribedAt);
    diffTimings.shown = await diffPage.evaluate<string[]>(changesOnScreen);
    if (JSON.stringify(diffTimings.shown) !== JSON.stringify(SEED_ARCH_CHANGE)) {
      failures.push(
        `the diff of V1 and V2 lists ${JSON.stringify(diffTimings.shown)}, the seed scripted ${JSON.stringify(SEED_ARCH_CHANGE)}`,
      );
    }
    writeFileSync(join(outDir, 'arch-diff.png'), await diffPage.screenshot(1440));
    // check-app's description is written only now: it is in V2's architecture, so the diff above
    // would list it as changed.
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

    v2Arch = await archOf(db, factory, v2);
    diffTimings.stepToScreenMs = await archStepToScreen(diffPage, db, v2Arch, addedSteps);
    deps.out(`first step reached the diff in ${diffTimings.stepToScreenMs ?? 'never'} ms`);

    // Last before the hold: making a rewind branch starts a new Neon compute on the project, so
    // every other screen's first snapshots are timed before it.
    await rewind.beforeHold();

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
    for (const q of LAPS_QUERIES) {
      lapsTimings.renewals[q] = await lapsPage.evaluate<number>(renewalsOf(q));
    }
    const secondLane = untilShown(lapsPage, laneOn(secondLap, LIVE_STEP));
    mapTimings.afterHoldInsertToScreenMs = await stepToScreen(
      page,
      deps,
      secondLap,
      onLiveStep + 2,
    );
    lapsTimings.afterHoldStepToLane = { run: secondLap, ms: await secondLane };
    lapsTimings.noReload = await lapsPage.evaluate<boolean>('window.__mcNoReload === true');
    await lapsPage.close();
    lapsPage = undefined;

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
    versionTimings.afterHoldPinToScreenMs = await writeToScreen(
      versionsPage,
      deps,
      ['pin'],
      entriesAre(entries + 2),
    );
    await latestPin();
    versionTimings.noReload = await versionsPage.evaluate<boolean>('window.__mcNoReload === true');
    await versionsPage.close();
    versionsPage = undefined;

    scorecardTimings.renewals = await scorePage.evaluate<number>(
      `performance.getEntriesByName('live:scorecard:renewed').length`,
    );
    scorecardTimings.afterHoldMergeToScreenMs = await landToScreen(scorePage, merges + 2);
    scorecardTimings.noReload = await scorePage.evaluate<boolean>('window.__mcNoReload === true');
    await scorePage.close();
    scorePage = undefined;

    for (const q of DECISION_QUERIES) {
      decisionTimings.renewals[q] = await decisionsPage.evaluate<number>(
        `performance.getEntriesByName('live:${q}:renewed').length`,
      );
    }
    // The second verdict judges the newest pin: the versions screen wrote it, so it is being tested.
    const [newest] = await db.query('SELECT sha FROM mc.pins ORDER BY committed_at DESC LIMIT 1');
    const judged = String(newest.sha);
    decisionTimings.afterHoldVerdictToScreenMs = await writeToScreen(
      decisionsPage,
      deps,
      ['verdict', '--pin', judged],
      `${inLedger('verdicts', judged)} && !(${inLedger('testing', judged)})`,
    );
    await latestVerdict();
    const decisionsBeforeHold = await fixtureDecisions();
    decisionTimings.afterHoldDecisionToScreenMs = await writeToScreen(
      decisionsPage,
      deps,
      ['decision'],
      `document.querySelectorAll('${DECISION}').length === ${timelineLength + 2}`,
    );
    await newDecisions(decisionsBeforeHold);
    decisionTimings.noReload = await decisionsPage.evaluate<boolean>(
      'window.__mcNoReload === true',
    );
    await decisionsPage.close();
    decisionsPage = undefined;

    issueTimings.renewals = await issuesPage.evaluate<number>(
      `performance.getEntriesByName('live:issue-graph:renewed').length`,
    );
    issueTimings.afterHoldLabelToScreen = await labelToScreen(
      issuesPage,
      db,
      deps,
      factory,
      labelled,
    );
    issueTimings.noReload = await issuesPage.evaluate<boolean>('window.__mcNoReload === true');
    await issuesPage.close();
    issuesPage = undefined;

    diffTimings.renewals = await diffPage.evaluate<number>(
      `performance.getEntriesByName('live:arch-diff:renewed').length`,
    );
    diffTimings.afterHoldStepToScreenMs = await archStepToScreen(diffPage, db, v2Arch, addedSteps);
    diffTimings.noReload = await diffPage.evaluate<boolean>('window.__mcNoReload === true');
    await diffPage.close();
    diffPage = undefined;

    await rewind.afterHold();
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
    const scorecardProbe = Bun.spawnSync(
      [
        'bun',
        'harness/design-probe.js',
        `${base}/f/${factory}/scorecard?a=${encodeURIComponent(v1)}&b=${encodeURIComponent(v2)}`,
        '--out',
        join(outDir, 'scorecard-design-probe.json'),
      ],
      { cwd: deps.repoRoot, env: deps.env, stdout: 'ignore', stderr: 'inherit' },
    );
    if (scorecardProbe.exitCode !== 0) {
      failures.push(`the design probe on the scorecard exited ${scorecardProbe.exitCode}`);
    }
    const decisionsProbe = Bun.spawnSync(
      [
        'bun',
        'harness/design-probe.js',
        `${base}/f/${factory}/decisions`,
        '--out',
        join(outDir, 'decisions-ledger-design-probe.json'),
      ],
      { cwd: deps.repoRoot, env: deps.env, stdout: 'ignore', stderr: 'inherit' },
    );
    if (decisionsProbe.exitCode !== 0) {
      failures.push(`the design probe on the decisions screen exited ${decisionsProbe.exitCode}`);
    }
    const issuesProbe = Bun.spawnSync(
      [
        'bun',
        'harness/design-probe.js',
        `${base}/f/${factory}/issues`,
        '--out',
        join(outDir, 'phases-issue-graph-design-probe.json'),
      ],
      { cwd: deps.repoRoot, env: deps.env, stdout: 'ignore', stderr: 'inherit' },
    );
    if (issuesProbe.exitCode !== 0) {
      failures.push(`the design probe on the issues screen exited ${issuesProbe.exitCode}`);
    }
    const lapsProbe = Bun.spawnSync(
      [
        'bun',
        'harness/design-probe.js',
        `${base}/f/${factory}/laps`,
        '--out',
        join(outDir, 'lanes-recent-laps-design-probe.json'),
      ],
      { cwd: deps.repoRoot, env: deps.env, stdout: 'ignore', stderr: 'inherit' },
    );
    if (lapsProbe.exitCode !== 0) {
      failures.push(`the design probe on the laps screen exited ${lapsProbe.exitCode}`);
    }
    const diffProbe = Bun.spawnSync(
      [
        'bun',
        'harness/design-probe.js',
        `${base}${diffTimings.url}`,
        '--out',
        join(outDir, 'arch-diff-design-probe.json'),
      ],
      { cwd: deps.repoRoot, env: deps.env, stdout: 'ignore', stderr: 'inherit' },
    );
    if (diffProbe.exitCode !== 0) {
      failures.push(`the design probe on the diff screen exited ${diffProbe.exitCode}`);
    }
  } finally {
    for (const panel of panels) {
      writeFileSync(
        join(outDir, `${panel.file}-timings.json`),
        `${JSON.stringify(panel.timings, null, 2)}\n`,
      );
    }
    writeFileSync(
      join(outDir, 'step-detail-timings.json'),
      `${JSON.stringify(stepTimings, null, 2)}\n`,
    );
    writeFileSync(
      join(outDir, 'version-strip-timings.json'),
      `${JSON.stringify(versionTimings, null, 2)}\n`,
    );
    writeFileSync(
      join(outDir, 'scorecard-timings.json'),
      `${JSON.stringify(scorecardTimings, null, 2)}\n`,
    );
    writeFileSync(
      join(outDir, 'decisions-ledger-timings.json'),
      `${JSON.stringify(decisionTimings, null, 2)}\n`,
    );
    writeFileSync(
      join(outDir, 'phases-issue-graph-timings.json'),
      `${JSON.stringify(issueTimings, null, 2)}\n`,
    );
    writeFileSync(
      join(outDir, 'lanes-recent-laps-timings.json'),
      `${JSON.stringify(lapsTimings, null, 2)}\n`,
    );
    writeFileSync(
      join(outDir, 'arch-diff-timings.json'),
      `${JSON.stringify(diffTimings, null, 2)}\n`,
    );
    // The pages and the server go first, so a failed cleanup below cannot leave them running.
    await page?.close().catch(() => undefined);
    await stepPage?.close().catch(() => undefined);
    await versionsPage?.close().catch(() => undefined);
    await scorePage?.close().catch(() => undefined);
    await decisionsPage?.close().catch(() => undefined);
    await issuesPage?.close().catch(() => undefined);
    await lapsPage?.close().catch(() => undefined);
    await diffPage?.close().catch(() => undefined);
    if (server) {
      server.kill();
      await server.exited;
    }
    failures.push(...(await rewind.cleanup()));
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
    }
    try {
      if (v2Arch !== undefined && addedSteps.length > 0) {
        await db.query(
          `DELETE FROM mc.arch_steps WHERE archon_sha = $1 AND factory_sha = $2
           AND workflow = 'archon-loop' AND path = ANY($3::text[])`,
          [v2Arch.archon_sha, v2Arch.factory_sha, `{${addedSteps.join(',')}}`],
        );
      }
    } catch (err) {
      failures.push(`removing the inserted steps failed: ${(err as Error).message}`);
    }
    try {
      // Archon's event rows the writes added stay: only `fixture:*` writes them on a check branch.
      for (const { runId, row } of landed) {
        await db.transaction(async (tx) => {
          await tx.query(`DELETE FROM mc.lap_steps WHERE run_id = $1 AND step_id = 'land'`, [
            runId,
          ]);
          if (row !== null) {
            await tx.query(
              'INSERT INTO mc.lap_steps SELECT * FROM jsonb_populate_record(NULL::mc.lap_steps, $1::text::jsonb)',
              [row],
            );
          }
        });
      }
    } catch (err) {
      failures.push(`restoring the landed laps' land steps failed: ${(err as Error).message}`);
    }
    try {
      if (judgedBy.length > 0) {
        await db.query('DELETE FROM mc.verdicts WHERE sha = ANY($1::text[])', [
          `{${judgedBy.join(',')}}`,
        ]);
      }
      for (const title of decided) {
        await db.query('DELETE FROM mc.decisions WHERE title = $1', [title]);
      }
    } catch (err) {
      failures.push(
        `removing the written verdicts and decisions failed: ${(err as Error).message}`,
      );
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
    }
    try {
      if (labelled.length > 0) {
        await db.query(
          `DELETE FROM mc.issue_labels
           WHERE factory = $1 AND label = 'needs-owner' AND issue_number = ANY($2::int[])`,
          [factory, `{${labelled.join(',')}}`],
        );
      }
    } catch (err) {
      failures.push(`removing the written labels failed: ${(err as Error).message}`);
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
  if (!within(scorecardTimings.readyMs, LIMITS.readyMs)) {
    failures.push(`scorecard ready after ${scorecardTimings.readyMs} ms, limit ${LIMITS.readyMs}`);
  }
  if (!within(scorecardTimings.firstSnapshotMs, LIMITS.firstSnapshotMs)) {
    failures.push(
      `scorecard first snapshot after ${scorecardTimings.firstSnapshotMs} ms, limit ${LIMITS.firstSnapshotMs}`,
    );
  }
  if (!within(scorecardTimings.mergeToScreenMs, LIMITS.insertToScreenMs)) {
    failures.push(
      `first merge reached the scorecard after ${scorecardTimings.mergeToScreenMs} ms, limit ${LIMITS.insertToScreenMs}`,
    );
  }
  if (!within(scorecardTimings.afterHoldMergeToScreenMs, LIMITS.insertToScreenMs)) {
    failures.push(
      `merge after ${holdSeconds}s reached the scorecard after ${scorecardTimings.afterHoldMergeToScreenMs} ms, limit ${LIMITS.insertToScreenMs}`,
    );
  }
  if (holdSeconds >= 180 && (scorecardTimings.renewals ?? 0) < RENEWALS_IN_180S) {
    failures.push(
      `${scorecardTimings.renewals} scorecard seal renewals in ${holdSeconds}s, expected at least ${RENEWALS_IN_180S}`,
    );
  }
  if (scorecardTimings.noReload !== true) failures.push('the scorecard reloaded');
  if (!within(decisionTimings.readyMs, LIMITS.readyMs)) {
    failures.push(
      `decisions screen ready after ${decisionTimings.readyMs} ms, limit ${LIMITS.readyMs}`,
    );
  }
  for (const q of DECISION_QUERIES) {
    if (!within(decisionTimings.firstSnapshotMs[q], LIMITS.firstSnapshotMs)) {
      failures.push(
        `${q} first snapshot after ${decisionTimings.firstSnapshotMs[q]} ms, limit ${LIMITS.firstSnapshotMs}`,
      );
    }
    if (holdSeconds >= 180 && (decisionTimings.renewals[q] ?? 0) < RENEWALS_IN_180S) {
      failures.push(
        `${decisionTimings.renewals[q]} ${q} seal renewals in ${holdSeconds}s, expected at least ${RENEWALS_IN_180S}`,
      );
    }
  }
  for (const [what, ms] of [
    ["V2's verdict reached the ledger", decisionTimings.verdictToScreenMs],
    ['a decision reached the timeline', decisionTimings.decisionToScreenMs],
    [
      `a verdict after ${holdSeconds}s reached the ledger`,
      decisionTimings.afterHoldVerdictToScreenMs,
    ],
    [
      `a decision after ${holdSeconds}s reached the timeline`,
      decisionTimings.afterHoldDecisionToScreenMs,
    ],
  ] as const) {
    if (!within(ms, LIMITS.insertToScreenMs)) {
      failures.push(`${what} after ${ms} ms, limit ${LIMITS.insertToScreenMs}`);
    }
  }
  if (decisionTimings.noReload !== true) failures.push('the decisions screen reloaded');

  if (!within(issueTimings.readyMs, LIMITS.readyMs)) {
    failures.push(`issues screen ready after ${issueTimings.readyMs} ms, limit ${LIMITS.readyMs}`);
  }
  if (!within(issueTimings.firstSnapshotMs, LIMITS.firstSnapshotMs)) {
    failures.push(
      `issues screen first snapshot after ${issueTimings.firstSnapshotMs} ms, limit ${LIMITS.firstSnapshotMs}`,
    );
  }
  for (const [when, write] of [
    ['first', issueTimings.labelToScreen],
    [`after ${holdSeconds}s`, issueTimings.afterHoldLabelToScreen],
  ] as const) {
    if (!within(write?.ms ?? null, LIMITS.insertToScreenMs)) {
      failures.push(
        `label ${when} reached the issues screen after ${write?.ms} ms, limit ${LIMITS.insertToScreenMs}`,
      );
    }
  }
  if (holdSeconds >= 180 && (issueTimings.renewals ?? 0) < RENEWALS_IN_180S) {
    failures.push(
      `${issueTimings.renewals} issues seal renewals in ${holdSeconds}s, expected at least ${RENEWALS_IN_180S}`,
    );
  }
  if (issueTimings.noReload !== true) failures.push('the issues screen reloaded');

  if (!within(lapsTimings.readyMs, LIMITS.readyMs)) {
    failures.push(`laps screen ready after ${lapsTimings.readyMs} ms, limit ${LIMITS.readyMs}`);
  }
  for (const q of LAPS_QUERIES) {
    if (!within(lapsTimings.firstSnapshotMs[q], LIMITS.firstSnapshotMs)) {
      failures.push(
        `${q} first snapshot after ${lapsTimings.firstSnapshotMs[q]} ms, limit ${LIMITS.firstSnapshotMs}`,
      );
    }
    if (holdSeconds >= 180 && (lapsTimings.renewals[q] ?? 0) < RENEWALS_IN_180S) {
      failures.push(
        `${lapsTimings.renewals[q]} ${q} seal renewals in ${holdSeconds}s, expected at least ${RENEWALS_IN_180S}`,
      );
    }
  }
  for (const [when, write] of [
    ['first', lapsTimings.stepToLane],
    [`after ${holdSeconds}s`, lapsTimings.afterHoldStepToLane],
  ] as const) {
    if (!within(write?.ms ?? null, LIMITS.insertToScreenMs)) {
      failures.push(
        `${LIVE_STEP} ${when} reached its lane after ${write?.ms} ms, limit ${LIMITS.insertToScreenMs}`,
      );
    }
  }
  if (lapsTimings.noReload !== true) failures.push('the laps screen reloaded');
  if (!within(diffTimings.readyMs, LIMITS.readyMs)) {
    failures.push(`diff screen ready after ${diffTimings.readyMs} ms, limit ${LIMITS.readyMs}`);
  }
  if (!within(diffTimings.firstSnapshotMs, LIMITS.firstSnapshotMs)) {
    failures.push(
      `diff screen first snapshot after ${diffTimings.firstSnapshotMs} ms, limit ${LIMITS.firstSnapshotMs}`,
    );
  }
  if (!within(diffTimings.stepToScreenMs, LIMITS.insertToScreenMs)) {
    failures.push(
      `first step reached the diff screen after ${diffTimings.stepToScreenMs} ms, limit ${LIMITS.insertToScreenMs}`,
    );
  }
  if (!within(diffTimings.afterHoldStepToScreenMs, LIMITS.insertToScreenMs)) {
    failures.push(
      `step after ${holdSeconds}s reached the diff screen after ${diffTimings.afterHoldStepToScreenMs} ms, limit ${LIMITS.insertToScreenMs}`,
    );
  }
  if (holdSeconds >= 180 && (diffTimings.renewals ?? 0) < RENEWALS_IN_180S) {
    failures.push(
      `${diffTimings.renewals} diff seal renewals in ${holdSeconds}s, expected at least ${RENEWALS_IN_180S}`,
    );
  }
  if (diffTimings.noReload !== true) failures.push('the diff screen reloaded');
  failures.push(...rewind.judge());
  if (failures.length > 0) throw new Error(failures.join('\n'));
  deps.out(`live: ${JSON.stringify(timings)}`);
  deps.out(`step detail: ${JSON.stringify(stepTimings)}`);
  deps.out(`home map: ${JSON.stringify(mapTimings)}`);
  deps.out(`versions: ${JSON.stringify(versionTimings)}`);
  deps.out(`scorecard: ${JSON.stringify(scorecardTimings)}`);
  deps.out(`decisions: ${JSON.stringify(decisionTimings)}`);
  deps.out(`issues: ${JSON.stringify(issueTimings)}`);
  deps.out(`laps: ${JSON.stringify(lapsTimings)}`);
  deps.out(`diff: ${JSON.stringify(diffTimings)}`);
  deps.out(`rewind: ${JSON.stringify(rewind.timings)}`);
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
