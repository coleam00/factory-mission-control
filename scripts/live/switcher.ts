import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SECOND_FACTORY } from '../fixture/seed';
import { openPage, type Page } from '../lib/cdp';
import { runsQueryPage } from './runs';
import {
  freePort,
  LIMITS,
  type LiveContext,
  type LiveOutput,
  type LivePhase,
  lapsOnCards,
  lateWrite,
  liveOutputs,
  MAP,
  mapCards,
  mapMismatches,
  PANEL,
  pageWait,
  READY_WAIT_MS,
  RUN_ROW,
  settleAt,
  waitForHealth,
} from './shared';
import {
  emptyPanelTimings,
  measurePanels,
  type PanelTimings,
  performanceFailures,
  readyFailures,
} from './timings';

interface SwitcherTimings extends PanelTimings {
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
// The pill's first child span holds the factory name; the engine version follows it (#297).
const switcherNames = (factory: string) =>
  `document.querySelector('${SWITCHER} summary span:last-child')?.firstChild?.textContent === ${JSON.stringify(factory)}`;
const RUNNING_SQL = `SELECT f.name, (SELECT count(*)::int FROM mc.laps l
    WHERE l.factory = f.name AND l.status = 'running') AS running
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

const FILES = liveOutputs({
  shot: 'switcher.png',
  check: 'switcher-check.txt',
  timings: 'switcher-timings.json',
  probe: 'switcher-design-probe.json',
});
export const SWITCHER_OUTPUTS: readonly LiveOutput[] = Object.values(FILES);

const namesIn = (file: string): string[] =>
  (JSON.parse(readFileSync(file, 'utf-8')) as { factories: { name: string }[] }).factories.map(
    (f) => f.name,
  );

/**
 * The factory switcher on the running app (#77): it lists every row of `mc.factories` its
 * server's factories file names, with its running laps, live; choosing the seed's second factory shows its name, map and laps, keeps the screen
 * (a step's page too), and is remembered; a remembered factory that no longer exists falls back with no error. A server reading
 * factories.json alone lists only its factories, though the seed's second is in `mc.factories`.
 */
async function checkSwitcher(ctx: LiveContext): Promise<void> {
  const { deps, db, base, factory, factoriesFile, inserted, failures } = ctx;
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
    ...emptyPanelTimings(),
    insertToScreenMs: null,
    noReload: null,
    limits: LIMITS,
  };
  const counts = async () =>
    (await db.query(RUNNING_SQL)).map((r) => [String(r.name), Number(r.running)] as const);
  const shownBy = (names: readonly string[]) =>
    counts().then((rows) => rows.filter(([name]) => names.includes(name)));
  const listed = await shownBy(namesIn(factoriesFile));
  const second = SECOND_FACTORY.name;
  if (!listed.some(([name]) => name === second)) {
    failures.push(
      `switcher: mc.factories holds no ${second}, the check needs the seed's second factory`,
    );
    return;
  }
  const page = await openPage(deps.env);
  try {
    await page.goto(`${base}/f/${factory}/map`);
    await page.evaluate('window.__mcNoReload = true');
    await openList(page);
    Object.assign(
      timings,
      (
        await measurePanels(
          page,
          ['factory-switcher'],
          { db, branch: ctx.homeBranch, selectedBranch: null },
          ctx.queries,
          factory,
          READY_WAIT_MS,
        )
      )['factory-switcher'],
    );
    const shown = await page.evaluate<[string, number][]>(entriesOnScreen);
    const byName = (rows: readonly (readonly [string, number])[]) =>
      [...rows].sort(([a], [b]) => a.localeCompare(b));
    check('the factories on /', byName(shown), byName(listed));
    check('the first entry', shown[0]?.[0], factory);
    // The footer's engine travels from the status strip to the switcher.
    const [strip0] = await db.query(ctx.queries.get('status-strip') as string, [factory]);
    const expectedEngine = strip0?.engine ? String(strip0.engine).slice(0, 8) : null;
    // The engine is reported by the status strip's own effect, so the switcher can be ready first.
    // With no engine expected nothing renders, so wait for the strip to settle instead.
    await (expectedEngine
      ? waitFor(
          page,
          'the engine beside the switcher did not appear',
          `document.querySelector('[data-engine]') !== null`,
        )
      : waitFor(
          page,
          'the status strip was not ready',
          `document.querySelector('${PANEL}[data-state="ready"]') !== null`,
        ));
    check(
      'the engine beside the switcher',
      await page.evaluate<string | null>(
        `document.querySelector('[data-engine]')?.textContent ?? null`,
      ),
      expectedEngine,
    );
    failures.push(
      ...(await settleAt(
        page,
        1440,
        `document.querySelector('${SWITCHER}[data-state="ready"]') !== null`,
        'the switcher',
      )),
    );
    ctx.save(FILES.shot, await page.screenshot(1440));
    // The screenshot resizes across the shell's phone breakpoint, which remounts the switcher closed.
    await openList(page);

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

    check(
      'choosing it from the map',
      await choose(page, second, `/f/${second}/map`),
      `/f/${second}/map`,
    );
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
    const map = mapMismatches(await mapCards(page), await lapsOnCards(db, second));
    check(`${second}'s map against its laps`, map, []);

    // On a factory's own Attention the nav links its places at once; on / it waits for the factory.
    await page.goto(`${base}/f/${factory}`);
    const screenLinks = `[...document.querySelectorAll('nav[aria-label="Places"] a')].map((a) => a.getAttribute('href')).filter((href) => href.startsWith('/f/${factory}/'))`;
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
      if (screen !== 'runs') continue;
      await waitFor(
        page,
        'the runs were not ready',
        `document.querySelector('[data-live="runs"][data-state="ready"]') !== null`,
      );
      const runs = await page.evaluate<string[]>(
        `[...document.querySelectorAll('${RUN_ROW}')].map((el) => el.getAttribute('data-run'))`,
      );
      // The page hides idle polls by default: newest first, as the screen orders them.
      const newest = (await runsQueryPage(db, ctx.queries, second, true)).runs;
      check(`${second}'s runs`, runs, newest);
    }

    // Choosing a factory from a step's page stays on that step, in the chosen factory (#202).
    const stepPage = (name: string) => `/f/${name}/steps/archon-loop/check-app`;
    for (const name of [factory, second]) {
      await page.goto(`${base}${stepPage(name === factory ? second : factory)}`);
      check(
        `choosing ${name} from step detail`,
        await choose(page, name, stepPage(name)),
        stepPage(name),
      );
      await waitFor(page, `step detail did not show ${name}`, switcherNames(name));
    }

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
    await page.evaluate(
      `document.querySelector('nav[aria-label="Places"] a[href$="/map"]')?.click()`,
    );
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
    const port = await freePort(deps);
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
    ctx.save(FILES.check, `${lines.join('\n')}\n`);
    ctx.save(FILES.timings, `${JSON.stringify(timings, null, 2)}\n`);
  }

  failures.push(...readyFailures('the switcher', timings, LIMITS.readyMs));
  failures.push(...performanceFailures('factory-switcher', timings));
  failures.push(...lateWrite('an insert', 'the switcher', timings.insertToScreenMs));
  if (timings.noReload !== true) failures.push('the page reloaded while the switcher counted');

  ctx.designProbe(`${base}/f/${second}`, FILES.probe, `/f/${second}`);
}

/** The factory switcher's phase: all of it runs among the writes before the hold. */
export function switcherPhase(ctx: LiveContext): LivePhase {
  return { write: () => checkSwitcher(ctx) };
}
