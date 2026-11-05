import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type BoardRow, boardView } from '../../app/lib/board';
import type { HealthWorkableRow } from '../../app/lib/health';
import type { OwnerQueueRow } from '../../app/lib/owner-queue';
import type { HomeMapRow, WorkOrderRow } from '../../app/map/live';
import { QUEUE_FACTORY, QUEUE_RUNS } from '../fixture/seed';
import { FACTORY } from '../fixture/write';
import { openPage, type Page } from '../lib/cdp';
import { BUILD_STEP } from './queue-map';
import {
  LIMITS,
  type LiveContext,
  type LivePhase,
  lateWrite,
  pageWait,
  READY_WAIT_MS,
  writeToScreen,
} from './shared';

const DEMO = 'demo';
const READY = 'main[data-board][data-state="ready"]';

interface Shown {
  columns: [id: string, count: number, numbers: number[]][];
  orders: [name: string, text: string][];
  notInOrder: string;
  cardOrders: string[];
}

const SHOWN = `(() => {
  const text = (el) => (el?.textContent ?? '').replace(/\\s+/g, ' ').trim();
  return {
    columns: [...document.querySelectorAll('[data-board-column]')].map((c) => [
      c.getAttribute('data-board-column'),
      Number(c.getAttribute('data-count')),
      [...c.querySelectorAll('[data-work-item]')].map((a) => Number(a.getAttribute('data-work-item'))),
    ]),
    orders: [...document.querySelectorAll('[data-work-order]')].map((b) => [
      b.getAttribute('data-work-order'),
      text(b.querySelector('span:nth-of-type(2)')),
    ]),
    notInOrder: text(document.querySelector('[data-not-in-order]')),
    cardOrders: [...document.querySelectorAll('[data-work-item]')].map((a) =>
      text(a.querySelector('[data-chip="order"]')),
    ),
  };
})()`;

/** The Board (#316): its columns and work order panels equal a recount, and it moves without a reload. */
export function boardPhase(ctx: LiveContext): LivePhase {
  const { deps, db, outDir, queries } = ctx;
  const ms = { demoPanel: null as number | null, intakeToBuild: null as number | null };

  const run = async <Row>(name: string, factory: string, ...args: string[]) =>
    (await db.query(queries.get(name) as string, [factory, ...args])) as unknown as Row[];

  /** What the board must show for `factory`, from the same five queries run straight against the database. */
  async function recount(factory: string, order: string | null) {
    const view = boardView(
      {
        factory,
        board: await run<BoardRow>('board', factory),
        map: await run<HomeMapRow>('home-map', factory, ''),
        workable: await run<HealthWorkableRow>('health-workable', factory),
        owner: await run<OwnerQueueRow>('owner-queue', factory),
        orders: await run<WorkOrderRow>('work-orders', factory),
      },
      new Date(),
      order,
    );
    return {
      columns: view.columns.map((c) => [c.id, c.items.length, c.items.map((i) => i.number)]),
      orders: view.orders.map((o) => [
        o.name,
        `${o.merged} of ${o.total} merged${o.landsOn === null ? '' : ` · lands on ${o.landsOn}`}`,
      ]),
      notInOrder: `${view.notInOrder} not in a work order`,
    };
  }

  async function mismatches(page: Page, factory: string, order: string | null) {
    const screen = await page.evaluate<Shown>(SHOWN);
    const sql = await recount(factory, order);
    const where = `board ${factory}${order ? ` ?order=${order}` : ''}`;
    return (['columns', 'orders', 'notInOrder'] as const).flatMap((what) =>
      JSON.stringify(screen[what]) === JSON.stringify(sql[what])
        ? []
        : [
            `${where} ${what}: screen ${JSON.stringify(screen[what])}, SQL ${JSON.stringify(sql[what])}`,
          ],
    );
  }

  const open = async (page: Page, path: string) => {
    await page.goto(`${ctx.base}${path}`);
    await page.evaluate<boolean>(
      pageWait(`document.querySelector('${READY}') !== null`, READY_WAIT_MS),
    );
  };

  async function restore(): Promise<void> {
    await db.query('DELETE FROM mc.issue_labels WHERE factory = $1 AND label = $2', [
      FACTORY,
      `work-order:${DEMO}`,
    ]);
    await db.query(
      'DELETE FROM remote_agent_workflow_events WHERE workflow_run_id = $1 AND step_name = $2',
      [QUEUE_RUNS.build, BUILD_STEP],
    );
    await db.query('DELETE FROM mc.lap_steps WHERE run_id = $1 AND step_id = $2', [
      QUEUE_RUNS.build,
      BUILD_STEP,
    ]);
  }

  const path = `/f/${FACTORY}/board`;
  return {
    async write() {
      const { failures } = ctx;
      const page = await openPage(deps.env);
      try {
        await page.setViewport(1440);
        await open(page, path);
        writeFileSync(join(outDir, 'board.png'), await page.screenshot(1440));
        failures.push(...(await mismatches(page, FACTORY, null)));

        ms.demoPanel = await writeToScreen(
          page,
          deps,
          ['label', '--label', `work-order:${DEMO}`],
          `document.querySelector('[data-work-order="${DEMO}"]') !== null`,
        );
        failures.push(...(await mismatches(page, FACTORY, null)));

        await open(page, `${path}?order=${DEMO}`);
        const pressed = await page.evaluate<string | null>(
          `document.querySelector('[data-work-order="${DEMO}"]')?.getAttribute('aria-pressed') ?? null`,
        );
        if (pressed !== 'true') {
          failures.push(`board ?order=${DEMO}: the panel's aria-pressed is ${pressed}`);
        }
        failures.push(...(await mismatches(page, FACTORY, DEMO)));
        for (const text of (await page.evaluate<Shown>(SHOWN)).cardOrders) {
          if (text !== DEMO)
            failures.push(`board ?order=${DEMO} shows a card of work order "${text}"`);
        }
        await page.evaluate(`document.querySelector('[data-work-order="${DEMO}"]').click()`);
        const cleared = await page.evaluate<boolean>(
          pageWait(`!location.search.includes('order=')`, READY_WAIT_MS),
        );
        if (!cleared)
          failures.push('board: clicking the pressed panel left ?order= in the address');

        await open(page, `/f/${QUEUE_FACTORY.name}/board`);
        const intake = await page.evaluate<boolean>(
          `document.querySelector('[data-board-column="intake"] [data-work-item="401"]') !== null`,
        );
        if (!intake) failures.push('board: work item 401 is not in Intake before its build step');
        ms.intakeToBuild = await writeToScreen(
          page,
          deps,
          ['step', '--run', QUEUE_RUNS.build, '--step', BUILD_STEP, '--event', 'node_started'],
          `document.querySelector('[data-board-column="build"] [data-work-item="401"]') !== null`,
        );
        failures.push(...(await mismatches(page, QUEUE_FACTORY.name, null)));
      } finally {
        await page.close().catch(() => undefined);
        await restore();
      }
    },

    async probe(designProbe) {
      designProbe(`${ctx.base}${path}`, 'board-design-probe.json', 'the board');
    },

    async cleanup() {
      try {
        await restore();
        return [];
      } catch (err) {
        return [`restoring the board's rows failed: ${(err as Error).message}`];
      }
    },

    judge: () => [
      ...lateWrite('a work-order:demo label', `the board's ${DEMO} panel`, ms.demoPanel),
      ...lateWrite('a build step on 401', `${QUEUE_FACTORY.name}'s Build column`, ms.intakeToBuild),
    ],

    summary: () => [`board: ${JSON.stringify({ ...ms, limit: LIMITS.insertToScreenMs })}`],
  };
}
