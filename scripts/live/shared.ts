import { SERVE_PORTS } from '../../server/ports';
import type { Page } from '../lib/cdp';
import type { Deps } from '../lib/cli';
import type { Db } from '../lib/db';
import { LOCK_POLL_MS, LOCK_WAIT_MS } from '../lib/machine-lock';
import { type PanelTimings, PERFORMANCE_LIMITS, type TimingDatabase } from './timings';

export const LIMITS = { readyMs: 2000, ...PERFORMANCE_LIMITS, insertToScreenMs: 5000 };

/**
 * The failure of a write timed to a screen: none within the limit, otherwise one line naming the
 * reading and its value, `never` when the screen did not show the write within the limit.
 */
export function lateWrite(
  reading: string,
  screen: string,
  ms: number | null | undefined,
): string[] {
  const limit = LIMITS.insertToScreenMs;
  if (ms == null) return [`${reading} never reached ${screen} within ${limit} ms`];
  return ms > limit ? [`${reading} reached ${screen} after ${ms} ms, limit ${limit}`] : [];
}

export const RENEWALS_IN_180S = 3;
export const PANEL = '[data-live="status-strip"]';
export const MAP = '[data-live="home-map"]';
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
export const LIVE_STEP = 'review';
export const VERSIONS = '[data-live="version-strip"]';
export const ENTRY = `${VERSIONS} [data-version-entry]`;
export const LANE = '[data-live="lanes"] [data-lane]';
/** How long to wait for `ready` before giving up; the limit is judged on the page's own marks. */
export const READY_WAIT_MS = 10_000;

function portIsFree(port: number): boolean {
  try {
    Bun.listen({ hostname: '127.0.0.1', port, socket: { data() {} } }).stop(true);
    return true;
  } catch {
    return false;
  }
}

/**
 * The first free port in 8850-8864. While every one is taken (other checks on this machine are
 * serving), it waits for one up to `waitMs`, as long as the machine lock waits, then throws.
 */
export async function freePort(
  deps: Pick<Deps, 'now' | 'sleep' | 'out'>,
  options: { waitMs?: number; pollMs?: number; free?: (port: number) => boolean } = {},
): Promise<number> {
  const waitMs = options.waitMs ?? LOCK_WAIT_MS;
  const pollMs = options.pollMs ?? LOCK_POLL_MS;
  const free = options.free ?? portIsFree;
  const range = `${SERVE_PORTS.min}-${SERVE_PORTS.max}`;
  const started = deps.now().getTime();
  for (let waiting = false; ; waiting = true) {
    for (let port = SERVE_PORTS.min; port <= SERVE_PORTS.max; port++) {
      if (free(port)) {
        if (waiting) deps.out(`port ${port} is free`);
        return port;
      }
    }
    const waited = deps.now().getTime() - started;
    if (waited >= waitMs) {
      throw new Error(`no free port in ${range} after ${Math.round(waited / 60_000)} min`);
    }
    if (!waiting) {
      deps.out(
        `every port in ${range} is taken: waiting for one (up to ${Math.round(waitMs / 60_000)} min)`,
      );
    }
    await deps.sleep(pollMs);
  }
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

export interface ShownNode {
  role: string;
  step: string | null;
  count: string | null;
}

export const mapNodes = (page: Page) =>
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
export async function lapsOnNodes(db: Db, factory: string): Promise<(path: string) => number> {
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
export function mapMismatches(nodes: ShownNode[], lapsOn: (path: string) => number): string[] {
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

export const renewalsOf = (query: string) =>
  `performance.getEntriesByName('live:${query}:renewed').length`;

/** Runs `fixture:write <args>` to its exit, which is after its transaction has committed. */
export async function fixtureWrite(deps: Deps, args: readonly string[]): Promise<void> {
  const write = Bun.spawn(['bun', 'run', 'fixture:write', ...args], {
    cwd: deps.repoRoot,
    env: deps.env,
    stdout: 'ignore',
    stderr: 'inherit',
  });
  const exitCode = await write.exited;
  if (exitCode !== 0) {
    throw new Error(`bun run fixture:write ${args.join(' ')} exited ${exitCode}`);
  }
}

/** Starts timing `condition` on `page` now; resolves to its milliseconds, or null past the limit. */
export function untilShown(page: Page, condition: string): Promise<number | null> {
  const started = performance.now();
  return page
    .evaluate<boolean>(pageWait(condition, LIMITS.insertToScreenMs), LIMITS.insertToScreenMs + 5000)
    .then((shown) => (shown ? Math.round(performance.now() - started) : null));
}

/**
 * Runs `fixture:write <args>` and times it from the write's exit to `condition` holding on the
 * page. Starting the clock at the spawn instead would charge a process start, which takes seconds
 * on a busy machine, to the screen's limit.
 */
export async function writeToScreen(
  page: Page,
  deps: Deps,
  args: readonly string[],
  condition: string,
): Promise<number | null> {
  await fixtureWrite(deps, args);
  return untilShown(page, condition);
}

export const within = (value: number | null, limit: number) => value !== null && value <= limit;

/** The factory's version digests by first run, as the versions screen lists them. */
export async function versionDigests(db: Db, factory: string): Promise<string[]> {
  const rows = await db.query(
    'SELECT digest FROM mc.versions WHERE factory = $1 ORDER BY first_run_at',
    [factory],
  );
  return rows.map((r) => String(r.digest));
}

/** Runs harness/design-probe.js on `url`; `on` names the screen in the failure. */
export type DesignProbe = (url: string, file: string, on?: string) => void;

/** What every phase shares: built before the app is served; `port`, `base` and `laps` are set once it is. */
export interface LiveContext {
  deps: Deps;
  db: Db;
  outDir: string;
  /** factories.json's first. */
  factory: string;
  /** The factories file the app's server reads (`MC_FACTORIES_FILE`): factories.json's and the seed's second. */
  factoriesFile: string;
  holdSeconds: number;
  homeBranch: string;
  queries: ReadonlyMap<string, string>;
  /** `MC_CHECK_BRANCH`, or null: every timings file's `branch`. */
  branch: string | null;
  timingDatabase: TimingDatabase;
  measure: (page: Page, names: readonly string[]) => Promise<Record<string, PanelTimings>>;
  /** Set when the app is served. */
  port: number | null;
  base: string;
  /** The two running seed laps that have no LIVE_STEP yet; set before `open`. */
  laps: [string, string];
  /** Runs `fixture:write step` starting LIVE_STEP on `run` and awaits every phase's `onLapStep`. */
  lapStep(run: string, afterHold: boolean): Promise<void>;
  /** Laps test:live inserted (any phase); the runner deletes them. */
  inserted: string[];
  /** Failures found while running; judged with every phase's `judge()`. */
  failures: string[];
}

/**
 * One screen's part of test:live. The runner calls each hook for every phase, in list order, so
 * a phase's writes keep their place against every other screen's reads.
 */
export interface LivePhase {
  /** On the untouched seed, before test:live writes a row: opens its screen and checks it. */
  open?(): Promise<void>;
  /** Before the hold, after the phases before it in the list have written: its first writes. */
  write?(): Promise<void>;
  /** Last before the hold, once every phase has written. */
  beforeHold?(): Promise<void>;
  /** Times the shared lap step event on its screen; `lapStep` calls it once the write has exited. */
  onLapStep?(run: string, afterHold: boolean): Promise<void>;
  /** After the hold: its renewals, its write again, and closing its page. */
  writeAgain?(): Promise<void>;
  /** Last after the hold, once every phase has written again. */
  afterHold?(): Promise<void>;
  /** After every timed write: checks that need no timing, then its design probes. */
  probe?(designProbe: DesignProbe): Promise<void>;
  /** Always (the runner's finally, before the server stops): writes its timings files and closes its pages. */
  close?(): Promise<void>;
  /** After the server stops: removes or restores what it wrote. */
  cleanup?(): Promise<string[]>;
  /** Its limits, once everything is cleaned up. */
  judge?(): string[];
  /** Its `deps.out` lines when test:live passes. */
  summary?(): string[];
}

/** What a phase opened or read in an earlier hook; the runner calls no later hook once one throws. */
export function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`test:live has no ${what}: an earlier step did not run`);
  return value;
}
