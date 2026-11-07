import { type WorkItemRow, workItemTimeline } from '../../app/lib/work-item';
import { QUEUE_FACTORY, QUEUE_RETURNED, QUEUE_RUNS } from '../fixture/seed';
import { MARKER } from '../fixture/seed-report';
import { FACTORY } from '../fixture/write';
import { openPage, type Page } from '../lib/cdp';
import { BUILD_STEP } from './queue-map';
import {
  type LiveContext,
  type LiveOutput,
  type LivePhase,
  lateWrite,
  liveOutputs,
  pageWait,
  READY_WAIT_MS,
  writeToScreen,
} from './shared';

const READY = 'main[data-work-item][data-state="ready"]';
/** The seed's work items on the old loop, whose pages must show no hidden check line or text. */
const LOOP_ITEMS = [2, 3, 7, 9, 13];
/** The loop work item whose two refused land attempts the page must show, verbatim. */
const REFUSED_ITEM = 3;

const SHOWN = `[...document.querySelectorAll('[data-event]')].map((li) =>
  (li.textContent ?? '').replace(/\\s+/g, ' ').trim())`;
const MARKERS = `document.documentElement.outerHTML.split(${JSON.stringify(MARKER)}).length - 1`;

/** Rows whose dot's vertical centre is outside the time's line box: the dot belongs beside the entry's first line. */
const DOTS_OFF_TIME = `[...document.querySelectorAll('[data-event]')].flatMap((li, i) => {
  const t = li.querySelector('time').getBoundingClientRect();
  const d = li.querySelector('[aria-hidden]').getBoundingClientRect();
  const mid = (d.top + d.bottom) / 2;
  return mid >= t.top && mid <= t.bottom ? [] : [i + ': dot ' + mid.toFixed(1) + ' time ' + t.top.toFixed(1) + '-' + t.bottom.toFixed(1)];
})`;

const FILES = liveOutputs({
  shot: 'work-item.png',
  loopShot: 'work-item-loop.png',
  probe: 'work-item-design-probe.json',
});
export const WORK_ITEM_OUTPUTS: readonly LiveOutput[] = Object.values(FILES);

/** The work item page (#317): its timeline equals a recount, shows no hidden line, and a running row moves. */
export function workItemPhase(ctx: LiveContext): LivePhase {
  const { deps, db, queries } = ctx;
  const ms = { runningRow: null as number | null };

  const open = async (page: Page, factory: string, number: number) => {
    await page.goto(`${ctx.base}/f/${factory}/work/${number}`);
    await page.evaluate<boolean>(
      pageWait(`document.querySelector('${READY}') !== null`, READY_WAIT_MS),
    );
  };

  /** What the page must list for the work item, from the query run straight against the database. */
  async function recount(factory: string, number: number) {
    const rows = (await db.query(queries.get('work-item') as string, [
      factory,
      String(number),
    ])) as unknown as WorkItemRow[];
    return workItemTimeline(rows, factory);
  }

  async function mismatches(page: Page, factory: string, number: number): Promise<string[]> {
    const where = `work item ${factory} #${number}`;
    const shown = await page.evaluate<string[]>(SHOWN);
    const events = await recount(factory, number);
    const markers = await page.evaluate<number>(MARKERS);
    return [
      ...(shown.length === events.length
        ? events.flatMap((e, i) =>
            shown[i]?.includes(e.text)
              ? []
              : [`${where} row ${i}: screen "${shown[i]}", SQL "${e.text}"`],
          )
        : [`${where}: screen shows ${shown.length} rows, SQL ${events.length}`]),
      ...(markers === 0 ? [] : [`${where}: ${MARKER} occurs ${markers} times on the page`]),
    ];
  }

  async function restore(): Promise<void> {
    await db.query(
      'DELETE FROM remote_agent_workflow_events WHERE workflow_run_id = $1 AND step_name = $2',
      [QUEUE_RUNS.build, BUILD_STEP],
    );
    await db.query('DELETE FROM mc.lap_steps WHERE run_id = $1 AND step_id = $2', [
      QUEUE_RUNS.build,
      BUILD_STEP,
    ]);
  }

  const returned = `/f/${QUEUE_FACTORY.name}/work/${QUEUE_RETURNED.issue}`;
  return {
    async write() {
      const { failures } = ctx;
      const page = await openPage(deps.env);
      try {
        await page.setViewport(1440);
        await open(page, QUEUE_FACTORY.name, QUEUE_RETURNED.issue);
        ctx.save(FILES.shot, await page.screenshot(1440));
        failures.push(...(await mismatches(page, QUEUE_FACTORY.name, QUEUE_RETURNED.issue)));
        for (const width of [1440, 390]) {
          await page.setViewport(width);
          for (const row of await page.evaluate<string[]>(DOTS_OFF_TIME))
            failures.push(`${returned} at ${width}: row ${row}`);
        }
        await page.setViewport(1440);
        const shown = await page.evaluate<string[]>(SHOWN);
        const back = shown.findIndex((t) => t.includes('Returned to Build'));
        const merged = shown.findIndex((t) => t.includes('Merged'));
        if (back < 0 || merged < 0 || back > merged)
          failures.push(
            `${returned}: the return (row ${back}) is not before the merge (row ${merged})`,
          );
        if (!shown.some((t) => t.includes(QUEUE_RETURNED.brief)))
          failures.push(`${returned}: the return's brief is not on the page`);

        for (const number of LOOP_ITEMS) {
          await open(page, FACTORY, number);
          failures.push(...(await mismatches(page, FACTORY, number)));
          if (number !== REFUSED_ITEM) continue;
          ctx.save(FILES.loopShot, await page.screenshot(1440));
          const refusals = (await page.evaluate<string[]>(SHOWN)).filter((t) =>
            t.includes('Merge gate refused'),
          );
          for (const reason of [
            'it changes .claude/settings.json, which only the owner changes',
            'the commit does not contain the current default branch',
          ]) {
            if (!refusals.some((t) => t.includes(`Merge gate refused: ${reason}`)))
              failures.push(
                `work item ${FACTORY} #${number}: the refusal "${reason}" is not on the page`,
              );
          }
        }

        await open(page, QUEUE_FACTORY.name, 401);
        ms.runningRow = await writeToScreen(
          page,
          deps,
          ['step', '--run', QUEUE_RUNS.build, '--step', BUILD_STEP, '--event', 'node_started'],
          `document.querySelector('[data-run="${QUEUE_RUNS.build}"][data-stage="build"]') !== null`,
        );
        failures.push(...(await mismatches(page, QUEUE_FACTORY.name, 401)));
      } finally {
        await page.close().catch(() => undefined);
        await restore();
      }
    },

    async probe(designProbe) {
      designProbe(`${ctx.base}${returned}`, FILES.probe, 'the work item page');
    },

    async cleanup() {
      try {
        await restore();
        return [];
      } catch (err) {
        return [`restoring the work item page's rows failed: ${(err as Error).message}`];
      }
    },

    judge: () => lateWrite('a build step on 401', "401's running row", ms.runningRow),

    summary: () => [`work item: ${JSON.stringify(ms)}`],
  };
}
