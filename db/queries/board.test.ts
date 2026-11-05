import { afterAll, beforeAll, expect, test } from 'bun:test';
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
  // 406 is needs-owner, which a queue factory does not read, and is not workable.
  const queue = await view('queue-factory');
  expect(columns(queue)).toEqual({
    queued: [404, 405],
    intake: [401],
    build: [],
    review: [],
    app: [],
    merge: [],
    decision: [],
    merged: [],
  });
  expect(queue.notInOrder).toBe(3);
});

test('a work item carries its pull request, rounds, route and app verdict from the seed laps', async () => {
  const rows = await run<BoardRow>('board', 'mission-control');
  const of = (n: number) => rows.find((r) => r.number === n);
  expect(of(9)).toMatchObject({ pr: 109, pr_open: true, work_order: 'foundations' });
  expect(of(10)).toMatchObject({ pr: 110, pr_open: false, state: 'closed' });
  expect(of(12)?.pr).toBe(112);
  expect(of(11)?.run_workflow).toBe('archon-loop');
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
