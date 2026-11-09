import {
  type BoardRow,
  boardView,
  type DiscoveryRow,
  found,
  MINI_CARDS,
  orderLine,
} from '../../app/lib/board';
import type { HealthWorkableRow } from '../../app/lib/health';
import type { OwnerQueueRow } from '../../app/lib/owner-queue';
import type { HomeMapRow, WorkOrderRow } from '../../app/map/live';
import { QUEUE_FACTORY, QUEUE_PARKED, QUEUE_RUNS, REFS_DELIVERED } from '../fixture/seed';
import { FACTORY } from '../fixture/write';
import { openPage, type Page } from '../lib/cdp';
import { BUILD_STEP } from './queue-map';
import {
  LIMITS,
  type LiveContext,
  type LiveOutput,
  type LivePhase,
  lateWrite,
  liveOutputs,
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
  older: number;
  cardOrders: string[][];
}

interface ShownPipeline {
  stages: [id: string, count: number, numbers: number[]][];
  found: [filed: number, tracked: number, dropped: number] | null;
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
      text(b.querySelector('[data-order-line]')),
    ]),
    notInOrder: text(document.querySelector('[data-not-in-order]')),
    older: Number(text(document.querySelector('[data-older]')).match(/\\d+/)?.[0] ?? 0),
    cardOrders: [...document.querySelectorAll('[data-work-item]')].map((a) =>
      [...a.querySelectorAll('[data-chip="order"]')].map(text),
    ),
  };
})()`;

const SHOWN_PIPELINE = `(() => {
  const found = document.querySelector('[data-found]');
  const n = (el, name) => Number(el.getAttribute(name));
  return {
    stages: [...document.querySelectorAll('[data-board-stage]')].map((c) => [
      c.getAttribute('data-board-stage'),
      Number(c.getAttribute('data-count')),
      [...c.querySelectorAll('[data-work-item]')].map((a) => Number(a.getAttribute('data-work-item'))),
    ]),
    found: found === null ? null : [n(found, 'data-filed'), n(found, 'data-tracked'), n(found, 'data-dropped')],
  };
})()`;

const FILES = liveOutputs({
  shot: 'board.png',
  probe: 'board-design-probe.json',
});
export const BOARD_OUTPUTS: readonly LiveOutput[] = Object.values(FILES);

/** The Board (#316): its columns and work order panels equal a recount, and it moves without a reload. */
export function boardPhase(ctx: LiveContext): LivePhase {
  const { deps, db, queries } = ctx;
  const ms = {
    demoPanel: null as number | null,
    refsMerged: null as number | null,
    intakeToBuild: null as number | null,
    unparked: null as number | null,
  };

  const run = async <Row>(name: string, factory: string, ...args: string[]) =>
    (await db.query(queries.get(name) as string, [factory, ...args])) as unknown as Row[];

  /** What the board must show for `factory`, from the same five queries run straight against the database. */
  async function sqlView(factory: string, order: string | null) {
    return boardView(
      {
        factory,
        board: await run<BoardRow>('board', factory),
        map: await run<HomeMapRow>('home-map', factory, ''),
        workable: await run<HealthWorkableRow>('health-workable', factory),
        owner: await run<OwnerQueueRow>('owner-queue', factory),
        orders: await run<WorkOrderRow>('work-orders', factory),
        discoveries: await run<DiscoveryRow>('discoveries', factory),
      },
      new Date(),
      order,
    );
  }

  async function recount(factory: string, order: string | null) {
    const view = await sqlView(factory, order);
    return {
      columns: view.columns.map((c) => [c.id, c.items.length, c.items.map((i) => i.number)]),
      orders: view.orders.map((o) => [o.name, orderLine(o)]),
      notInOrder: `${view.notInOrder} not in a work order`,
      older: view.older,
    };
  }

  /** The Pipeline's cards against the same recount: counts, the first mini cards, one home per item, and the found numbers. */
  async function pipelineMismatches(page: Page, factory: string): Promise<string[]> {
    const screen = await page.evaluate<ShownPipeline>(SHOWN_PIPELINE);
    const view = await sqlView(factory, null);
    const where = `board ${factory} pipeline`;
    const stages = view.pipeline.map((s) => [
      s.id,
      s.items.length,
      s.items.slice(0, MINI_CARDS).map((i) => i.number),
    ]);
    const { filed, tracked, dropped } = found(await run<DiscoveryRow>('discoveries', factory));
    const failures: string[] = [];
    if (JSON.stringify(screen.stages) !== JSON.stringify(stages))
      failures.push(
        `${where} stages: screen ${JSON.stringify(screen.stages)}, SQL ${JSON.stringify(stages)}`,
      );
    const homes = view.pipeline.flatMap((s) => s.items.map((i) => i.number));
    if (new Set(homes).size !== homes.length)
      failures.push(`${where}: a work item is in more than one stage`);
    const counted = screen.stages.reduce((sum, [, count]) => sum + count, 0);
    if (counted !== homes.length)
      failures.push(
        `${where}: the stage counts add to ${counted}, SQL places ${homes.length} items`,
      );
    if (JSON.stringify(screen.found) !== JSON.stringify([filed, tracked, dropped]))
      failures.push(
        `${where} found: screen ${JSON.stringify(screen.found)}, SQL ${JSON.stringify([filed, tracked, dropped])}`,
      );
    return failures;
  }

  async function mismatches(page: Page, factory: string, order: string | null) {
    const screen = await page.evaluate<Shown>(SHOWN);
    const sql = await recount(factory, order);
    const where = `board ${factory}${order ? ` ?order=${order}` : ''}`;
    return (['columns', 'orders', 'notInOrder', 'older'] as const).flatMap((what) =>
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
    await db.query(
      'UPDATE mc.work_item_states SET triage_at = $2, revision = $3 WHERE project_key = $1 AND number = $4',
      [QUEUE_FACTORY.codebase, QUEUE_PARKED.triagedAt, QUEUE_PARKED.revision, QUEUE_PARKED.issue],
    );
  }

  const path = `/f/${FACTORY}/board`;
  const table = `${path}?view=table`;
  return {
    async write() {
      const { failures } = ctx;
      const page = await openPage(deps.env);
      try {
        await page.setViewport(1440);
        await open(page, path);
        ctx.save(FILES.shot, await page.screenshot(1440));
        failures.push(...(await pipelineMismatches(page, FACTORY)));
        await open(page, table);
        failures.push(...(await mismatches(page, FACTORY, null)));
        const merged = await run<BoardRow>('board', FACTORY);
        if (!merged.some((r) => r.number === REFS_DELIVERED && r.state === 'closed'))
          failures.push(
            `board: #${REFS_DELIVERED}, delivered by a Refs pull request, is not among the merged rows`,
          );

        const [shownCard] = (await page.evaluate<Shown>(SHOWN)).columns.flatMap(
          ([, , numbers]) => numbers,
        );
        if (shownCard === undefined) throw new Error('the board shows no card for the demo label');
        ms.demoPanel = await writeToScreen(
          page,
          deps,
          ['label', '--label', `work-order:${DEMO}`, '--issue', String(shownCard)],
          `document.querySelector('[data-work-order="${DEMO}"]') !== null`,
        );
        failures.push(...(await mismatches(page, FACTORY, null)));

        const demo = (await sqlView(FACTORY, null)).orders.find((o) => o.name === DEMO);
        if (demo === undefined) throw new Error(`the board has no ${DEMO} work order`);
        const after = orderLine({ ...demo, merged: demo.merged + 1, total: demo.total + 1 });
        ms.refsMerged = await writeToScreen(
          page,
          deps,
          ['label', '--label', `work-order:${DEMO}`, '--issue', String(REFS_DELIVERED)],
          `(document.querySelector('[data-work-order="${DEMO}"] [data-order-line]')?.textContent ?? '').trim().startsWith('${after}')`,
        );
        failures.push(...(await mismatches(page, FACTORY, null)));

        await open(page, `${table}&order=${DEMO}`);
        const pressed = await page.evaluate<string | null>(
          `document.querySelector('[data-work-order="${DEMO}"]')?.getAttribute('aria-pressed') ?? null`,
        );
        if (pressed !== 'true') {
          failures.push(`board ?order=${DEMO}: the panel's aria-pressed is ${pressed}`);
        }
        failures.push(...(await mismatches(page, FACTORY, DEMO)));
        const { cardOrders } = await page.evaluate<Shown>(SHOWN);
        if (cardOrders.length === 0) failures.push(`board ?order=${DEMO} shows no card`);
        for (const names of cardOrders) {
          if (!names.includes(DEMO))
            failures.push(`board ?order=${DEMO} shows a card of work orders "${names.join(', ')}"`);
        }
        await page.evaluate(`document.querySelector('[data-work-order="${DEMO}"]').click()`);
        const cleared = await page.evaluate<boolean>(
          pageWait(`!location.search.includes('order=')`, READY_WAIT_MS),
        );
        if (!cleared)
          failures.push('board: clicking the pressed panel left ?order= in the address');

        await open(page, `/f/${QUEUE_FACTORY.name}/board`);
        failures.push(...(await pipelineMismatches(page, QUEUE_FACTORY.name)));
        await open(page, `/f/${QUEUE_FACTORY.name}/board?view=table`);
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

        const parked = await page.evaluate<boolean>(
          `document.querySelector('[data-board-column="parked"] [data-work-item="${QUEUE_PARKED.issue}"]') !== null`,
        );
        if (!parked) failures.push(`board: work item ${QUEUE_PARKED.issue} is not in Parked`);
        ms.unparked = await writeToScreen(
          page,
          deps,
          ['retriage', '--issue', String(QUEUE_PARKED.issue)],
          `document.querySelector('[data-board-column="parked"] [data-work-item="${QUEUE_PARKED.issue}"]') === null && document.querySelector('[data-board-column="queued"] [data-work-item="${QUEUE_PARKED.issue}"]') !== null`,
        );
        failures.push(...(await mismatches(page, QUEUE_FACTORY.name, null)));
      } finally {
        await page.close().catch(() => undefined);
        await restore();
      }
    },

    async probe(designProbe) {
      designProbe(`${ctx.base}${path}`, FILES.probe, 'the board');
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
      ...lateWrite(
        `a work-order:${DEMO} label on #${REFS_DELIVERED}, which a merged pull request names with Refs`,
        `the board's ${DEMO} panel`,
        ms.refsMerged,
      ),
      ...lateWrite('a build step on 401', `${QUEUE_FACTORY.name}'s Build column`, ms.intakeToBuild),
      ...lateWrite(
        `a re-triage of #${QUEUE_PARKED.issue}`,
        `${QUEUE_FACTORY.name}'s Queued column`,
        ms.unparked,
      ),
    ],

    summary: () => [`board: ${JSON.stringify({ ...ms, limit: LIMITS.insertToScreenMs })}`],
  };
}
