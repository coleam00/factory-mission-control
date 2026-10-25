import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createRealtimeClient, type WebSocketLike } from '@neon/realtime/client';
import { createRealtime, rawSql } from '@neon/realtime/server';
import { ISSUE_STATES, STATE_TOKEN } from '../app/lib/issue-graph';
import { realtimeUrlFor } from '../server/live';
import { SERVE_PORTS } from '../server/ports';
import { NEXT_TO_LABEL } from './fixture/write';
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
  '  On the same run it checks the versions screen against the seed, picks two versions, and times',
  '  `fixture:write pin` to that screen before and after the hold, writing version-strip-check.txt,',
  '  version-strip-timings.json, version-strip.png and version-strip-design-probe.json.',
  '  It checks the issues screen against the seed and times `fixture:write label` to it before and',
  '  after the hold, writing issue-graph-check.txt, phases-issue-graph-timings.json,',
  '  phases-issue-graph.png and phases-issue-graph-design-probe.json.',
  "  Then it opens the diff of the two versions, checks it lists exactly the seed's scripted change,",
  '  and times a step inserted into the second version to that screen before and after the hold,',
  '  writing arch-diff-timings.json, arch-diff.png and arch-diff-design-probe.json.',
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
const VERSIONS = '[data-live="version-strip"]';
const ENTRY = `${VERSIONS} [data-version-entry]`;
const ISSUES = '[data-live="issue-graph"]';
const DIFF = '[data-live="arch-diff"]';
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
async function stepToScreen(
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
  const db = deps.openDb(databaseUrl);
  let server: ReturnType<typeof Bun.spawn> | undefined;
  let page: Page | undefined;
  let versionsPage: Page | undefined;
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
    mapTimings.port = port;
    versionTimings.port = port;
    issueTimings.port = port;
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

    timings.insertToScreenMs = await insertToScreen(page, db, inserted, factory, before + 1);
    deps.out(`first insert reached the strip in ${timings.insertToScreenMs ?? 'never'} ms`);
    written.push(firstLap);
    mapTimings.insertToScreenMs = await writeToScreen(page, deps, firstLap, onLiveStep + 1);
    deps.out(`first step event reached the map in ${mapTimings.insertToScreenMs ?? 'never'} ms`);

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
    const versionsSubscribedAt = await versionsPage.evaluate<number | null>(
      markTime('live:version-strip:subscribe-sent'),
    );
    versionTimings.readyMs = versionsReadyAt === null ? null : Math.round(versionsReadyAt);
    versionTimings.firstSnapshotMs =
      versionsReadyAt === null || versionsSubscribedAt === null
        ? null
        : Math.round(versionsReadyAt - versionsSubscribedAt);
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
    v2Arch = await archOf(db, factory, v2);
    diffTimings.stepToScreenMs = await stepToScreen(diffPage, db, v2Arch, addedSteps);
    deps.out(`first step reached the diff in ${diffTimings.stepToScreenMs ?? 'never'} ms`);

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

    versionTimings.renewals = await versionsPage.evaluate<number>(
      `performance.getEntriesByName('live:version-strip:renewed').length`,
    );
    versionTimings.afterHoldPinToScreenMs = await pinToScreen(versionsPage, deps, entries + 2);
    await latestPin();
    versionTimings.noReload = await versionsPage.evaluate<boolean>('window.__mcNoReload === true');
    await versionsPage.close();
    versionsPage = undefined;

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
    diffTimings.afterHoldStepToScreenMs = await stepToScreen(diffPage, db, v2Arch, addedSteps);
    diffTimings.noReload = await diffPage.evaluate<boolean>('window.__mcNoReload === true');
    await diffPage.close();
    diffPage = undefined;

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
      join(outDir, 'version-strip-timings.json'),
      `${JSON.stringify(versionTimings, null, 2)}\n`,
    );
    writeFileSync(
      join(outDir, 'phases-issue-graph-timings.json'),
      `${JSON.stringify(issueTimings, null, 2)}\n`,
    );
    writeFileSync(
      join(outDir, 'arch-diff-timings.json'),
      `${JSON.stringify(diffTimings, null, 2)}\n`,
    );
    // The pages and the server go first, so a failed cleanup below cannot leave them running.
    await page?.close().catch(() => undefined);
    await versionsPage?.close().catch(() => undefined);
    await issuesPage?.close().catch(() => undefined);
    await diffPage?.close().catch(() => undefined);
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
  if (failures.length > 0) throw new Error(failures.join('\n'));
  deps.out(`live: ${JSON.stringify(timings)}`);
  deps.out(`home map: ${JSON.stringify(mapTimings)}`);
  deps.out(`versions: ${JSON.stringify(versionTimings)}`);
  deps.out(`issues: ${JSON.stringify(issueTimings)}`);
  deps.out(`diff: ${JSON.stringify(diffTimings)}`);
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
