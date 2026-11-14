import { stepPath } from '../../app/lib/lap-graph';
import { type Card, cardsCounting, FACTORY_MAP } from '../../app/map/factory-map';
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
/** The step `fixture:write` starts on running laps. */
export const LIVE_STEP = 'review';
export const VERSIONS = '[data-live="version-strip"]';
export const ENTRY = `${VERSIONS} [data-version-entry]`;
export const RUN_ROW = '[data-live="runs"] [data-run]';
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
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (exited()) throw new Error('the server exited before answering /api/health');
    const ok = await fetch(`${base}/api/health`).then(
      (res) => res.ok,
      () => false,
    );
    if (ok) return;
    await Bun.sleep(200);
  }
  throw new Error('the server did not answer /api/health within 60s');
}

/** Clicks `selector` on the page once it is there; false when it never shows. */
export async function click(page: Page, selector: string): Promise<boolean> {
  const shown = await page.evaluate<boolean>(
    pageWait(`document.querySelector('${selector}') !== null`, 2000),
  );
  if (shown) await page.evaluate(`document.querySelector('${selector}').click()`);
  return shown;
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

/**
 * Lays the page out at `width` from a fresh load and waits for `ready`. A resize across the shell's
 * 1024px layout switch remounts the routed page and drops its rows until its sources answer again (#713),
 * so a probe taken right after `setViewport` reads a loading Board or the pre-switch tree.
 */
export async function openAtWidth(
  page: Page,
  url: string,
  width: number,
  ready: string,
): Promise<void> {
  await page.setViewport(width);
  await page.goto(url);
  await page.evaluate<boolean>(
    pageWait(`document.querySelector('${ready}') !== null`, READY_WAIT_MS),
  );
}

const countIs = (target: number) =>
  `document.querySelector('${PANEL} [data-count]')?.getAttribute('data-count') === '${target}'`;

/** A card on the map and the laps it counts (`data-live-count`). */
export interface ShownCard {
  card: string;
  count: string | null;
}

export const mapCards = (page: Page) =>
  page.evaluate<ShownCard[]>(
    `[...document.querySelectorAll('${MAP} [data-card]')].map((el) => ({
      card: el.getAttribute('data-card'),
      count: el.getAttribute('data-live-count'),
    }))`,
  );

/**
 * The running runs of `factory` on each card, recounted from the laps tables by the PRD's rule: a
 * run counts once, on the card covering its deepest running step (the newest of those as deep).
 */
export async function lapsOnCards(db: Db, factory: string): Promise<Map<string, number>> {
  const running = await db.query(
    `SELECT l.run_id, l.workflow_name, ls.step_id
       FROM mc.lap_steps ls JOIN mc.laps l ON l.run_id = ls.run_id
      WHERE l.factory = $1 AND l.status = 'running' AND ls.status = 'running'
      ORDER BY ls.started_at DESC NULLS LAST, ls.step_id`,
    [factory],
  );
  const deepest = new Map<string, { workflow: string; step: string }>();
  for (const row of running) {
    const run = String(row.run_id);
    const step = String(row.step_id);
    const was = deepest.get(run);
    const depth = (id: string) => stepPath(id).split('/').length;
    if (was === undefined || depth(step) > depth(was.step)) {
      deepest.set(run, { workflow: String(row.workflow_name), step });
    }
  }
  const counts = new Map<string, number>();
  for (const { workflow, step } of deepest.values()) {
    for (const card of cardsCounting(FACTORY_MAP, workflow, stepPath(step))) {
      counts.set(card.id, (counts.get(card.id) ?? 0) + 1);
    }
  }
  return counts;
}

/**
 * The map's type at the fitted scale, in rendered pixels, its smallest of each kind, and how wide
 * its frame is against the page column: what the owner's readability rule judges (PR #326 review).
 */
export interface MapType {
  title: number;
  text: number;
  kind: number;
  /** A line's label or the group box's. */
  label: number;
  frameWidth: number;
  /** The route's `main` content width: the window less the nav, and the Manager dock when open. */
  columnWidth: number;
}

/** The window width the live check opens the map at. */
export const MAP_VIEWPORT = 1440;
/** The page's gutters either side of the map's frame, which spans the page column between them. */
const MAP_GUTTERS = 48;

export const mapType = (page: Page) =>
  page.evaluate<MapType>(
    `(() => {
      const k = new DOMMatrix(getComputedStyle(document.querySelector('${MAP} [data-map-world]')).transform).a;
      const least = (selector) => Math.min(...[...document.querySelectorAll('${MAP} ' + selector)]
        .map((el) => parseFloat(getComputedStyle(el).fontSize) * k));
      return {
        title: least('[data-card-title]'),
        text: least('[data-card-text]'),
        kind: least('[data-card-kind]'),
        label: Math.min(least('[data-line-label] text'), least('[data-group-label]')),
        frameWidth: document.querySelector('${MAP} [data-map-stage]').getBoundingClientRect().width,
        columnWidth: document.querySelector('${MAP} [data-map-stage]').closest('main').clientWidth,
      };
    })()`,
  );

/**
 * A frame narrower than the page column between its gutters. The map's type is measured and recorded
 * but not judged against the floors: the map opens fitted, so at 1440 it is under them (#655).
 */
export function mapWidthFailures(type: MapType): string[] {
  const failures: string[] = [];
  if (type.frameWidth < type.columnWidth - MAP_GUTTERS - 1) {
    failures.push(
      `the map's frame is ${Math.round(type.frameWidth)}px wide in a ${type.columnWidth}px page column: it should span the column inside the gutters`,
    );
  }
  return failures;
}

const STAGE = `${MAP} [data-map-stage]`;

/** In the page: the ids of the map's cards that lie outside its frame, empty when it shows the whole level. */
const OUTSIDE_FRAME = `(() => {
  const frame = document.querySelector('${STAGE}').getBoundingClientRect();
  return [...document.querySelectorAll('${MAP} [data-card]')]
    .filter((el) => {
      const r = el.getBoundingClientRect();
      return r.left < frame.left - 1 || r.top < frame.top - 1 ||
        r.right > frame.right + 1 || r.bottom > frame.bottom + 1;
    })
    .map((el) => el.getAttribute('data-card'));
})()`;
const cardsOutsideFrame = (page: Page) => page.evaluate<string[]>(OUTSIDE_FRAME);

/** Two animation frames, enough for a click's state to be drawn. */
const drawn = (page: Page) =>
  page.evaluate(`new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))`);

/**
 * The map opens with every card inside the frame, a Manager toggle before any move refits it, Fit
 * shows every card with the Manager open and closed, and a clicked card shows its details inside the
 * frame (#655; owner changes of 2026-11-12, item 11); what each misses, one line each.
 * Leaves the Manager as it found it and nothing selected.
 */
export async function mapFrameFailures(page: Page, card: string): Promise<string[]> {
  const failures: string[] = [];
  const fits = async (manager: string) => {
    await click(page, `${MAP} [aria-label="Fit"]`);
    await drawn(page);
    const outside = await cardsOutsideFrame(page);
    if (outside.length > 0) {
      failures.push(
        `Fit with the Manager ${manager} leaves ${outside.join(', ')} outside the map's frame`,
      );
    }
  };
  const opening = await cardsOutsideFrame(page);
  if (opening.length > 0) {
    failures.push(`the map opens with ${opening.join(', ')} outside its frame`);
  }
  // The refit lands after two observer passes, so it is polled, not sampled once.
  const refits = async () => {
    const fitted = await page.evaluate<boolean>(pageWait(`${OUTSIDE_FRAME}.length === 0`, 2000));
    if (fitted) return;
    const outside = await cardsOutsideFrame(page);
    failures.push(`toggling the Manager leaves ${outside.join(', ')} outside the map's frame`);
  };
  await fits('as it was');
  const width = () =>
    page.evaluate<number>(`document.querySelector('${STAGE}').getBoundingClientRect().width`);
  const was = await width();
  const toggle = `nav[aria-label="Places"] button[aria-pressed]`;
  await click(page, toggle);
  await page.evaluate(
    pageWait(`document.querySelector('${STAGE}').getBoundingClientRect().width !== ${was}`, 2000),
  );
  await refits();
  await drawn(page);
  await fits('toggled');
  await click(page, toggle);
  await page.evaluate(
    pageWait(`document.querySelector('${STAGE}').getBoundingClientRect().width === ${was}`, 2000),
  );
  await refits();
  await click(page, `${MAP} [data-card="${card}"]`);
  await drawn(page);
  const inFrame = await page.evaluate<boolean>(`(() => {
    const frame = document.querySelector('${STAGE}').getBoundingClientRect();
    const r = document.querySelector('${MAP} [data-map-details]')?.getBoundingClientRect();
    return r !== undefined && r.left >= frame.left - 1 && r.top >= frame.top - 1 &&
      r.right <= frame.right + 1 && r.bottom <= frame.bottom + 1;
  })()`);
  if (!inFrame) failures.push(`the details of ${card} are missing or outside the map's frame`);
  await page.evaluate(
    `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`,
  );
  return failures;
}

/** Where the map, in document order, differs from factory-map.json and from `counts`: one line each. */
export function mapMismatches(
  cards: ShownCard[],
  counts: ReadonlyMap<string, number>,
  expected: readonly Card[] = FACTORY_MAP.cards,
): string[] {
  const failures: string[] = [];
  const shown = cards.map((c) => c.card).join(', ');
  const drawn = expected.map((c) => c.id).join(', ');
  if (shown !== drawn) failures.push(`the map shows cards ${shown}, not ${drawn}`);
  for (const { card, count } of cards) {
    const want = counts.get(card) ?? 0;
    if (Number(count) !== want) {
      failures.push(`${card} shows ${count} laps, the database has ${want}`);
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

/** Compares what a screen shows with what SQL says, pushing one line to `mismatches` per difference. */
export const screenAgainstSql =
  (mismatches: string[]) => (what: string, screen: unknown, sql: unknown) => {
    if (JSON.stringify(screen) !== JSON.stringify(sql)) {
      mismatches.push(`${what}: screen ${JSON.stringify(screen)}, SQL ${JSON.stringify(sql)}`);
    }
  };

/** The factory's version digests by first run, as the versions screen lists them. */
export async function versionDigests(db: Db, factory: string): Promise<string[]> {
  const rows = await db.query(
    'SELECT digest FROM mc.versions WHERE factory = $1 ORDER BY first_run_at',
    [factory],
  );
  return rows.map((r) => String(r.digest));
}

declare const liveOutput: unique symbol;
/** A file a test:live phase writes to --out; only `liveOutputs` makes one, so --help names it. */
export type LiveOutput = string & { readonly [liveOutput]: true };

/** Declares a phase's files: the names its writes use and --help lists. */
export function liveOutputs<const K extends string>(
  files: Record<K, string>,
): Record<K, LiveOutput> {
  return files as Record<K, LiveOutput>;
}

/** Runs harness/design-probe.js on `url` into `file`; `on` names the screen in the failure. */
export type DesignProbe = (url: string, file: LiveOutput, on?: string) => void;

/** What every phase shares: built before the app is served; `port`, `base` and `laps` are set once it is. */
export interface LiveContext {
  deps: Deps;
  db: Db;
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
  /** Writes `file` to `--out`, and records it for the check that --help names every file written. */
  save(file: LiveOutput, data: string | Uint8Array): void;
  /** Runs harness/design-probe.js into `file` under `--out`, and records it. */
  designProbe: DesignProbe;
  /** Set when the app is served. */
  port: number | null;
  base: string;
  /** The two running seed laps that have no LIVE_STEP yet; set before `open`. */
  laps: [string, string];
  /**
   * Awaits every phase's `beforeLapStep`, runs `fixture:write step` starting LIVE_STEP on `run`,
   * then awaits every phase's `onLapStep`.
   */
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
  /** Reads what must be read before the shared lap step event is written; `lapStep` calls it first. */
  beforeLapStep?(afterHold: boolean): Promise<void>;
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
