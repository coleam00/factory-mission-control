import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cardForStep, FACTORY_MAP } from '../../app/map/factory-map';
import { openPage, type Page } from '../lib/cdp';
import {
  insertToScreen,
  LIMITS,
  LIVE_STEP,
  type LiveContext,
  type LivePhase,
  lapsOnCards,
  lateWrite,
  MAP,
  MAP_READABLE,
  type MapType,
  mapCards,
  mapMismatches,
  mapType,
  mapTypeFailures,
  PANEL,
  pageWait,
  READY_WAIT_MS,
  RENEWALS_IN_180S,
  renewalsOf,
  required,
  untilShown,
} from './shared';
import {
  collectPanelMarks,
  emptyPanelTimings,
  explainPanel,
  type PanelTimings,
  performanceFailures,
  readyFailures,
} from './timings';

/** Journey 1: App check's details, then its Behind the scenes, open check-app's step screen. */
const CLICKED_CARD = 'app';
const CLICKED_STEP = 'archon-loop check-app';
const CLICKED_SCREEN = '/steps/archon-loop/check-app';
/** The card `fixture:write` moves a lap onto: the one covering LIVE_STEP. */
const LIVE_CARD = cardForStep(FACTORY_MAP, 'archon-loop', LIVE_STEP)?.id ?? '';

export async function observeHomePanels(
  page: Page,
  panels: readonly { name: string; query: string; selector: string; timings: PanelTimings }[],
): Promise<void> {
  for (const panel of panels) {
    const ready = await page.evaluate<boolean>(
      pageWait(
        `document.querySelector('${panel.selector}[data-state="ready"]') !== null`,
        READY_WAIT_MS,
      ),
    );
    if (!ready)
      throw new Error(`${panel.name} did not reach data-state="ready" within ${READY_WAIT_MS} ms`);
    Object.assign(
      panel.timings,
      (await collectPanelMarks(page, [panel.query], READY_WAIT_MS))[panel.query],
    );
  }
}

/**
 * One panel's timings. `readyMs` is from navigation (connection setup to Neon included);
 * `firstSnapshotMs` retains the combined delivery/render interval as unjudged evidence (#141).
 * The strip's inserts are running laps;
 * the map's are `fixture:write step` events, timed from the write's exit.
 */
interface Timings extends PanelTimings {
  branch: string | null;
  port: number | null;
  insertToScreenMs: number | null;
  holdSeconds: number;
  renewals: number | null;
  afterHoldInsertToScreenMs: number | null;
  noReload: boolean | null;
  /** Where App check's Behind the scenes link to check-app went. */
  clickedTo?: string | null;
  /** The map's smallest type at 1440 fitted, and its frame's width. */
  type?: MapType | null;
  limits: typeof LIMITS;
}

const liveCountOf = (card: string) =>
  `document.querySelector('${MAP} [data-card="${card}"]')?.getAttribute('data-live-count')`;

/** Clicks `selector` on the page once it is there; false when it never shows. */
async function click(page: Page, selector: string): Promise<boolean> {
  const shown = await page.evaluate<boolean>(
    pageWait(`document.querySelector('${selector}') !== null`, 2000),
  );
  if (shown) await page.evaluate(`document.querySelector('${selector}').click()`);
  return shown;
}

/** The home screen: the factory strip's inserted laps and the map's lap step events. */
export function homePhase(ctx: LiveContext): LivePhase {
  const { deps, db, factory, outDir, holdSeconds, branch, timingDatabase, queries, inserted } = ctx;
  const panelTimings = (): Timings => ({
    branch,
    port: null,
    ...emptyPanelTimings(),
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
  let homePage: Page | undefined;
  let before = 0;
  let onLiveStep = 0;

  return {
    async open() {
      const { base } = ctx;
      const page = await openPage(deps.env);
      homePage = page;
      await page.setViewport(MAP_READABLE.width);
      await page.goto(`${base}/`);
      await page.evaluate('window.__mcNoReload = true');
      await observeHomePanels(page, panels);
      for (const panel of panels)
        await explainPanel(panel.query, panel.timings, timingDatabase, queries, factory);
      before = Number(
        await page.evaluate<string>(
          `document.querySelector('${PANEL} [data-count]').getAttribute('data-count')`,
        ),
      );
      ctx.failures.push(...mapMismatches(await mapCards(page), await lapsOnCards(db, factory)));
      await page.evaluate(
        pageWait(`document.querySelector('${MAP} [data-placed]') !== null`, 2000),
      );
      mapTimings.type = await mapType(page);
      ctx.failures.push(...mapTypeFailures(mapTimings.type));
      writeFileSync(join(outDir, 'home-map.png'), await page.screenshot(1440));
      onLiveStep = Number(await page.evaluate<string>(liveCountOf(LIVE_CARD)));
    },

    async write() {
      const page = required(homePage, 'home page');
      const [firstLap] = ctx.laps;
      timings.insertToScreenMs = await insertToScreen(page, db, inserted, factory, before + 1);
      deps.out(`first insert reached the strip in ${timings.insertToScreenMs ?? 'never'} ms`);
      await ctx.lapStep(firstLap, false);
      deps.out(`first step event reached the map in ${mapTimings.insertToScreenMs ?? 'never'} ms`);
    },

    async onLapStep(_run, afterHold) {
      const target = onLiveStep + (afterHold ? 2 : 1);
      const page = required(homePage, 'home page');
      const ms = await untilShown(page, `${liveCountOf(LIVE_CARD)} === '${target}'`);
      if (afterHold) mapTimings.afterHoldInsertToScreenMs = ms;
      else mapTimings.insertToScreenMs = ms;
      // The lap left the card it was on: every card's count agrees with the laps tables.
      ctx.failures.push(...mapMismatches(await mapCards(page), await lapsOnCards(db, factory)));
    },

    async writeAgain() {
      const page = required(homePage, 'home page');
      const [, secondLap] = ctx.laps;
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
      await ctx.lapStep(secondLap, true);

      const opened =
        (await click(page, `${MAP} [data-card="${CLICKED_CARD}"]`)) &&
        (await click(page, `[data-details="${CLICKED_CARD}"] [data-tab="behind"]`)) &&
        (await click(page, `[data-step-link="${CLICKED_STEP}"]`));
      if (opened) {
        await page.evaluate<boolean>(pageWait(`location.pathname === '${CLICKED_SCREEN}'`, 2000));
      }
      mapTimings.clickedTo = await page.evaluate<string>('location.pathname');
      if (mapTimings.clickedTo !== CLICKED_SCREEN) {
        ctx.failures.push(
          `App check's Behind the scenes ${CLICKED_STEP} opened ${mapTimings.clickedTo}, not ${CLICKED_SCREEN}`,
        );
      }
      timings.noReload = await page.evaluate<boolean>('window.__mcNoReload === true');
      mapTimings.noReload = timings.noReload;
      await page.close();
      homePage = undefined;
    },

    async probe(designProbe) {
      const { base } = ctx;
      designProbe(`${base}/`, 'home-map-design-probe.json');
    },

    async close() {
      timings.port = ctx.port;
      mapTimings.port = ctx.port;
      for (const panel of panels) {
        writeFileSync(
          join(outDir, `${panel.file}-timings.json`),
          `${JSON.stringify(panel.timings, null, 2)}\n`,
        );
      }
      await homePage?.close().catch(() => undefined);
    },

    judge() {
      const failures: string[] = [];
      for (const { name, timings: t } of panels) {
        failures.push(...readyFailures(name, t, LIMITS.readyMs));
        failures.push(...performanceFailures(name, t));
        failures.push(...lateWrite('the first insert', name, t.insertToScreenMs));
        failures.push(
          ...lateWrite(`the insert after ${holdSeconds}s`, name, t.afterHoldInsertToScreenMs),
        );
        if (holdSeconds >= 180 && (t.renewals ?? 0) < RENEWALS_IN_180S) {
          failures.push(
            `${t.renewals} seal renewals of ${name} in ${holdSeconds}s, expected at least ${RENEWALS_IN_180S}`,
          );
        }
      }
      if (timings.noReload !== true) failures.push('the page reloaded');
      return failures;
    },

    summary: () => [`live: ${JSON.stringify(timings)}`, `home map: ${JSON.stringify(mapTimings)}`],
  };
}
