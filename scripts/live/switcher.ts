import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openPage, type Page } from '../lib/cdp';
import type { Deps } from '../lib/cli';
import type { Db } from '../lib/db';
import {
  freePort,
  LANE,
  LIMITS,
  lapsOnNodes,
  MAP,
  mapMismatches,
  mapNodes,
  markTime,
  PANEL,
  pageWait,
  READY_WAIT_MS,
  waitForHealth,
} from '../test-live';

export interface SwitcherContext {
  deps: Deps;
  db: Db;
  base: string;
  outDir: string;
  /** The default factory: factories.json's first. */
  factory: string;
  /** The factories file the app's server reads (`MC_FACTORIES_FILE`): factories.json's and the seed's second. */
  factoriesFile: string;
  /** Laps test:live inserted; its cleanup deletes them. */
  inserted: string[];
  failures: string[];
}

interface SwitcherTimings {
  readyMs: number | null;
  firstSnapshotMs: number | null;
  insertToScreenMs: number | null;
  noReload: boolean | null;
  limits: typeof LIMITS;
}

const SWITCHER = '[data-live="factory-switcher"]';
const entry = (factory: string) => `${SWITCHER} [data-factory-entry=${JSON.stringify(factory)}]`;
const runningOf = (factory: string) =>
  `document.querySelector('${entry(factory)}')?.getAttribute('data-running')`;
const entriesOnScreen = `[...document.querySelectorAll('${SWITCHER} [data-factory-entry]')].map((li) => [
  li.getAttribute('data-factory-entry'), Number(li.getAttribute('data-running'))])`;
const stripNames = (factory: string) =>
  `document.querySelector('${PANEL}[data-state="ready"] span')?.textContent === ${JSON.stringify(factory)}`;
const RUNNING_SQL = `SELECT f.name, (SELECT count(*)::int FROM mc.laps l
    WHERE l.factory = f.name AND l.workflow_name = 'archon-loop' AND l.status = 'running') AS running
  FROM mc.factories f ORDER BY f.name`;

async function waitFor(page: Page, what: string, condition: string): Promise<void> {
  if (!(await page.evaluate<boolean>(pageWait(condition, READY_WAIT_MS)))) {
    throw new Error(`${what} within ${READY_WAIT_MS} ms`);
  }
}

/** Opens the switcher once its list is live; the list is in the page only while open. */
async function openList(page: Page): Promise<void> {
  await waitFor(
    page,
    'the switcher was not ready',
    `document.querySelector('${SWITCHER}[data-state="ready"]') !== null`,
  );
  await page.evaluate(
    `document.querySelector('${SWITCHER} details').open || document.querySelector('${SWITCHER} summary').click()`,
  );
  await waitFor(
    page,
    'the switcher listed no factory',
    `document.querySelector('${SWITCHER} [data-factory-entry]') !== null`,
  );
}

/** Chooses `factory` in the switcher and waits for the browser to reach `path`. */
async function choose(page: Page, factory: string, path: string): Promise<string> {
  await openList(page);
  await page.evaluate(`document.querySelector('${entry(factory)} a').click()`);
  await page.evaluate<boolean>(
    pageWait(`location.pathname === ${JSON.stringify(path)}`, READY_WAIT_MS),
  );
  return page.evaluate<string>('location.pathname');
}

const namesIn = (file: string): string[] =>
  (JSON.parse(readFileSync(file, 'utf-8')) as { factories: { name: string }[] }).factories.map(
    (f) => f.name,
  );

/**
 * The factory switcher on the running app (#77): it lists every row of `mc.factories` its
 * server's factories file names, with its running laps, live; choosing the second factory shows its name, map and laps, keeps the screen,
 * and is remembered; a remembered factory that no longer exists falls back with no error. A server reading
 * factories.json alone lists only its factories, though the seed's second is in `mc.factories`.
 */
export async function switcherPhase(ctx: SwitcherContext): Promise<void> {
  const { deps, db, base, outDir, factory, factoriesFile, inserted, failures } = ctx;
  const lines: string[] = [];
  const check = (what: string, shown: unknown, expected: unknown) => {
    const same = JSON.stringify(shown) === JSON.stringify(expected);
    lines.push(
      `${same ? 'ok  ' : 'FAIL'} ${what}: shown ${JSON.stringify(shown)}, expected ${JSON.stringify(expected)}`,
    );
    if (!same)
      failures.push(
        `switcher: ${what} shows ${JSON.stringify(shown)}, not ${JSON.stringify(expected)}`,
      );
  };
  const timings: SwitcherTimings = {
    readyMs: null,
    firstSnapshotMs: null,
    insertToScreenMs: null,
    noReload: null,
    limits: LIMITS,
  };
  const counts = async () =>
    (await db.query(RUNNING_SQL)).map((r) => [String(r.name), Number(r.running)] as const);
  const shownBy = (names: readonly string[]) =>
    counts().then((rows) => rows.filter(([name]) => names.includes(name)));
  const listed = await shownBy(namesIn(factoriesFile));
  const second = listed.map(([name]) => name).find((name) => name !== factory);
  if (second === undefined) {
    failures.push(
      `switcher: mc.factories holds ${listed.length} of the factories file's, the check needs two`,
    );
    return;
  }
  const page = await openPage(deps.env);
  try {
    await page.goto(`${base}/`);
    await page.evaluate('window.__mcNoReload = true');
    await openList(page);
    const readyAt = await page.evaluate<number | null>(markTime('live:factory-switcher:ready'));
    const sentAt = await page.evaluate<number | null>(
      markTime('live:factory-switcher:subscribe-sent'),
    );
    timings.readyMs = readyAt === null ? null : Math.round(readyAt);
    timings.firstSnapshotMs =
      readyAt === null || sentAt === null ? null : Math.round(readyAt - sentAt);
    const shown = await page.evaluate<[string, number][]>(entriesOnScreen);
    const byName = (rows: readonly (readonly [string, number])[]) =>
      [...rows].sort(([a], [b]) => a.localeCompare(b));
    check('the factories on /', byName(shown), byName(listed));
    check('the first entry', shown[0]?.[0], factory);
    writeFileSync(join(outDir, 'switcher.png'), await page.screenshot(1440));

    const before = listed.find(([name]) => name === second)?.[1] ?? 0;
    const started = performance.now();
    const counted = page.evaluate<boolean>(
      pageWait(`${runningOf(second)} === '${before + 1}'`, LIMITS.insertToScreenMs),
      LIMITS.insertToScreenMs + 5000,
    );
    const runId = crypto.randomUUID();
    inserted.push(runId);
    await db.query(
      `INSERT INTO mc.laps (run_id, factory, workflow_name, status) VALUES ($1, $2, 'archon-loop', 'running')`,
      [runId, second],
    );
    timings.insertToScreenMs = (await counted) ? Math.round(performance.now() - started) : null;
    check(
      `${second}'s count after an insert`,
      Number(await page.evaluate(runningOf(second))),
      before + 1,
    );
    timings.noReload = await page.evaluate<boolean>('window.__mcNoReload === true');

    check('choosing it from /', await choose(page, second, `/f/${second}`), `/f/${second}`);
    await waitFor(page, `the strip did not name ${second}`, stripNames(second));
    const strip = await page.evaluate<string>(
      `document.querySelector('${PANEL} [data-count]')?.getAttribute('data-count')`,
    );
    check(`${second}'s strip count`, Number(strip), before + 1);
    await waitFor(
      page,
      'the map was not ready',
      `document.querySelector('${MAP}[data-state="ready"]') !== null`,
    );
    const map = mapMismatches(await mapNodes(page), await lapsOnNodes(db, second));
    check(`${second}'s map against its laps`, map, []);

    // On a factory's own map the nav links its screens at once; on / it waits for the factory.
    await page.goto(`${base}/f/${factory}`);
    const screenLinks = `[...document.querySelectorAll('nav[aria-label="Screens"] a')].map((a) => a.getAttribute('href')).filter((href) => href.startsWith('/f/${factory}/'))`;
    await page.evaluate<boolean>(pageWait(`${screenLinks}.length > 0`, READY_WAIT_MS));
    const screens = await page.evaluate<string[]>(screenLinks);
    if (screens.length === 0) failures.push('switcher: the nav links no factory screen');
    for (const href of screens) {
      const screen = href.slice(href.indexOf('/', '/f/'.length) + 1);
      await page.goto(`${base}/f/${factory}/${screen}`);
      check(
        `choosing it from /f/${factory}/${screen}`,
        await choose(page, second, `/f/${second}/${screen}`),
        `/f/${second}/${screen}`,
      );
      if (screen !== 'laps') continue;
      await waitFor(
        page,
        'the lanes were not ready',
        `document.querySelector('[data-live="lanes"][data-state="ready"]') !== null`,
      );
      const lanes = await page.evaluate<string[]>(
        `[...document.querySelectorAll('${LANE}')].map((el) => el.getAttribute('data-lane')).sort()`,
      );
      const running = await db.query(
        `SELECT run_id::text AS run FROM mc.laps
          WHERE factory = $1 AND workflow_name = 'archon-loop' AND status = 'running' ORDER BY 1`,
        [second],
      );
      check(`${second}'s lanes`, lanes, running.map((r) => String(r.run)).sort());
    }

    await page.goto(`${base}/steps/archon-loop/check-app`);
    check(
      'choosing it from step detail',
      await choose(page, second, `/f/${second}`),
      `/f/${second}`,
    );

    await page.goto(`${base}/`);
    await waitFor(page, `/ did not show the remembered ${second}`, stripNames(second));
    check(
      'the factory / shows after choosing it',
      await page.evaluate<string>(`document.querySelector('${PANEL} span')?.textContent`),
      second,
    );

    await page.evaluate(`localStorage.setItem('mc:factory', 'removed-factory')`);
    await page.goto(`${base}/`);
    await waitFor(page, `/ did not fall back to ${factory}`, stripNames(factory));
    await waitFor(
      page,
      'the map was not ready',
      `document.querySelector('${MAP}[data-state="ready"]') !== null`,
    );
    check(
      'panels in error with a removed factory remembered',
      await page.evaluate<number>(
        `document.querySelectorAll('[data-live][data-state="error"]').length`,
      ),
      0,
    );
    check(
      'seals refused with a removed factory remembered',
      await page.evaluate<string[]>(
        `performance.getEntriesByType('resource').filter((e) => e.name.includes('/api/live/') && e.responseStatus >= 400).map((e) => e.name)`,
      ),
      [],
    );

    // factories.json alone: the seed's second factory is still a row of mc.factories.
    const own = namesIn(join(deps.repoRoot, 'factories.json'));
    const port = await freePort();
    const alone = `http://localhost:${port}`;
    const env = { ...deps.env };
    delete env.MC_FACTORIES_FILE;
    const proc = Bun.spawn(['bun', 'server/main.ts', '--port', String(port)], {
      cwd: deps.repoRoot,
      env,
      stdout: 'ignore',
      stderr: 'inherit',
    });
    try {
      await waitForHealth(alone, () => proc.exitCode !== null);
      await page.goto(`${alone}/`);
      await openList(page);
      const byName = (rows: readonly (readonly [string, number])[]) =>
        [...rows].sort(([a], [b]) => a.localeCompare(b));
      check(
        'the factories on / with factories.json alone',
        byName(await page.evaluate<[string, number][]>(entriesOnScreen)),
        byName(await shownBy(own)),
      );
      const sealed = await fetch(`${alone}/api/live/status-strip`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ factory: second }),
      });
      check(`a seal for ${second} with factories.json alone`, sealed.status, 400);
      await page.evaluate(`localStorage.setItem('mc:factory', ${JSON.stringify(second)})`);
      await page.goto(`${alone}/`);
      await waitFor(page, `/ did not fall back to ${factory}`, stripNames(factory));
      check(
        `the factory / shows with ${second} remembered and factories.json alone`,
        await page.evaluate<string>(`document.querySelector('${PANEL} span')?.textContent`),
        factory,
      );
    } finally {
      proc.kill();
      await proc.exited;
    }
  } finally {
    await page.close().catch(() => undefined);
    writeFileSync(join(outDir, 'switcher-check.txt'), `${lines.join('\n')}\n`);
    writeFileSync(join(outDir, 'switcher-timings.json'), `${JSON.stringify(timings, null, 2)}\n`);
  }

  const within = (value: number | null, limit: number) => value !== null && value <= limit;
  if (!within(timings.readyMs, LIMITS.readyMs)) {
    failures.push(`the switcher was ready after ${timings.readyMs} ms, limit ${LIMITS.readyMs}`);
  }
  if (!within(timings.firstSnapshotMs, LIMITS.firstSnapshotMs)) {
    failures.push(
      `the switcher's first snapshot came after ${timings.firstSnapshotMs} ms, limit ${LIMITS.firstSnapshotMs}`,
    );
  }
  if (!within(timings.insertToScreenMs, LIMITS.insertToScreenMs)) {
    failures.push(
      `an insert reached the switcher after ${timings.insertToScreenMs} ms, limit ${LIMITS.insertToScreenMs}`,
    );
  }
  if (timings.noReload !== true) failures.push('the page reloaded while the switcher counted');

  const probe = Bun.spawnSync(
    [
      'bun',
      'harness/design-probe.js',
      `${base}/f/${second}`,
      '--out',
      join(outDir, 'switcher-design-probe.json'),
    ],
    { cwd: deps.repoRoot, env: deps.env, stdout: 'ignore', stderr: 'inherit' },
  );
  if (probe.exitCode !== 0)
    failures.push(`the design probe on /f/${second} exited ${probe.exitCode}`);
}
