import { afterAll, beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { type BoardRow, boardView } from '../../app/lib/board';
import type { HealthWorkableRow } from '../../app/lib/health';
import type { OwnerQueueRow } from '../../app/lib/owner-queue';
import type { HomeMapRow, WorkOrderRow } from '../../app/map/live';
import type { Db } from '../../scripts/lib/db';
import { onTheSeed, queries } from './test-seed';

let db: Db;
beforeAll(async () => {
  db = await onTheSeed();
}, 60_000);
afterAll(() => db.close());

const run = async <Row>(name: string, ...args: string[]) =>
  (await db.query(queries.find(([n]) => n === name)?.[1] as string, args)) as unknown as Row[];

const NOW = new Date('2026-10-25T12:00:00Z');

async function view(factory: string, order: string | null = null) {
  return boardView(
    {
      factory,
      board: await run<BoardRow>('board', factory),
      map: await run<HomeMapRow>('home-map', factory, ''),
      workable: await run<HealthWorkableRow>('health-workable', factory),
      owner: await run<OwnerQueueRow>('owner-queue', factory),
      orders: await run<WorkOrderRow>('work-orders', factory),
    },
    NOW,
    order,
  );
}

test('the seed recount: each column and each work order bar equal the definitions', async () => {
  const columns = (v: Awaited<ReturnType<typeof view>>) =>
    Object.fromEntries(v.columns.map((c) => [c.id, c.items.map((i) => i.number)]));
  // mission-control at NOW. Open, by the rules in order: 9 has an open pull request and no run (Build,
  // waiting for a run); 11 runs `build` (Build); 12 runs `check-app` (App check). 13 to 16 have no
  // run and no open pull request and are not workable, so no column. 10 closed on 2026-10-20, inside
  // 7 days (Merged); the other seven merged-closed items (1, 2, 3, 5, 6, 7, 8) are older.
  const mission = await view('mission-control');
  expect(columns(mission)).toEqual({
    queued: [],
    intake: [],
    build: [9, 11],
    review: [],
    app: [12],
    merge: [],
    decision: [],
    merged: [10],
  });
  expect(mission.older).toBe(7);
  // foundations holds 5, 6, 7 (merged) and 9 (open); screens holds 10 (merged), 11, 12 and 14.
  expect(mission.orders).toEqual([
    { name: 'foundations', merged: 3, total: 4, landsOn: 'main' },
    { name: 'screens', merged: 1, total: 4, landsOn: 'staging' },
  ]);
  // The filter narrows the columns to the order, and leaves the panels.
  const screens = await view('mission-control', 'screens');
  expect(columns(screens)).toMatchObject({ build: [11], app: [12], merged: [10] });
  expect(screens.orders).toEqual(mission.orders);

  // queue-factory: 401 is in triage and built (the build run is between steps), so Intake; 402 and
  // 403 only have runs between steps, so no column; 404 and 405 are workable with no run (Queued);
  // 406 is needs-owner, which a queue factory does not read, and is not workable. 410 is a product
  // document, 411 and 412 are its merged pieces and 413 its open one (Queued).
  const queue = await view('queue-factory');
  expect(columns(queue)).toEqual({
    queued: [404, 405, 413],
    intake: [401],
    build: [],
    review: [],
    app: [],
    merge: [],
    decision: [],
    merged: [411, 412],
  });
  expect(queue.notInOrder).toBe(6);
});

test('a work item carries its pull request, rounds, route and app verdict from the seed laps', async () => {
  const rows = await run<BoardRow>('board', 'mission-control');
  const of = (n: number) => rows.find((r) => r.number === n);
  expect(of(9)).toMatchObject({
    pr: 109,
    pr_open: true,
    work_orders: ['foundations'],
    route: 'continue',
    rounds: 3,
    app_check: 'FAIL',
  });
  expect(of(10)).toMatchObject({
    pr: 110,
    pr_open: false,
    state: 'closed',
    route: 'simple',
    rounds: 1,
    app_check: 'PASS',
  });
  expect(of(12)).toMatchObject({ pr: 112, route: 'simple', rounds: 0, app_check: null });
  expect(of(11)?.run_workflow).toBe('archon-loop');
  expect(of(13)?.work_orders).toEqual([]);
});

test('each work order panel counts the board rows that name it', async () => {
  const rows = await run<BoardRow>('board', 'mission-control');
  const orders = await run<WorkOrderRow>('work-orders', 'mission-control');
  expect(orders.length).toBeGreaterThan(0);
  for (const o of orders)
    expect(rows.filter((r) => r.work_orders?.includes(o.name)).length).toBe(o.total_count);
});

test('an item in two work orders lists both by name, and the manager tracking issues are in neither query', async () => {
  await db.query(
    `INSERT INTO mc.issue_labels (factory, issue_number, label, labeled_at)
     VALUES ('mission-control', 11, 'work-order:zz', now()), ('mission-control', 11, 'work-order:aa', now())`,
  );
  // A computed path keeps tsc out of the pack, whose `.ts` import extensions this config refuses.
  const { MANAGER_TITLES } = await import(
    join(import.meta.dir, '..', '..', 'fixtures', 'pack', 'sdlc', '.shared', 'workable.ts')
  );
  const titles: string[] = [...MANAGER_TITLES];
  for (const [n, title] of titles.entries()) {
    await db.query(
      `INSERT INTO mc.issues (factory, number, title, state, url, created_at, updated_at)
       VALUES ('mission-control', ${900 + n}, $1, 'open', 'u', now(), now())`,
      [title],
    );
    await db.query(
      `INSERT INTO mc.issue_labels (factory, issue_number, label, labeled_at)
       VALUES ('mission-control', ${900 + n}, 'work-order:aa', now())`,
    );
  }
  try {
    const rows = await run<BoardRow>('board', 'mission-control');
    expect(rows.find((r) => r.number === 11)?.work_orders).toEqual(['aa', 'screens', 'zz']);
    expect(rows.filter((r) => (r.number ?? 0) >= 900)).toEqual([]);
    const orders = await run<WorkOrderRow>('work-orders', 'mission-control');
    expect(orders.find((o) => o.name === 'aa')?.total_count).toBe(1);
    for (const o of orders)
      expect(rows.filter((r) => r.work_orders?.includes(o.name)).length).toBe(o.total_count);
  } finally {
    await db.query(
      `DELETE FROM mc.issue_labels WHERE factory = 'mission-control' AND (label IN ('work-order:zz', 'work-order:aa'))`,
    );
    await db.query(`DELETE FROM mc.issues WHERE factory = 'mission-control' AND number >= 900`);
  }
});

test('the factory row counts only the work items a merged pull request closed', async () => {
  const [factory] = (await run<BoardRow>('board', 'mission-control')).filter(
    (r) => r.kind === 'factory',
  );
  expect(factory).toMatchObject({
    repository: 'coleam00/factory-mission-control',
    merged_total: 8,
  });
});
