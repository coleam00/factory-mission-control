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
  // 7 days (Merged); the other merged-closed items (1, 2, 3, 5, 6, 7, 8) and 4, closed as completed
  // after #103 named it with `Refs`, are older.
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
  expect(mission.older).toBe(8);
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
  expect(of(13)?.work_orders).toEqual([]);
});

test("a queue factory's check step is the app verdict, and another queue workflow's is not", async () => {
  await db.query('BEGIN');
  try {
    const [lap] = await db.query(
      `SELECT run_id FROM mc.laps WHERE factory = 'mission-control' AND status = 'completed' LIMIT 1`,
    );
    await db.query(
      `INSERT INTO mc.lap_steps (run_id, step_id, status, started_at, output)
        VALUES ($1, 'check', 'completed', '2030-01-01T00:00:00Z', '{"pr":112,"overall":"FAIL"}')`,
      [lap?.run_id],
    );
    const verdict = async (workflow: string) => {
      await db.query('UPDATE mc.laps SET workflow_name = $2 WHERE run_id = $1', [
        lap?.run_id,
        workflow,
      ]);
      const rows = await run<BoardRow>('board', 'mission-control');
      return rows.find((r) => r.number === 12)?.app_check;
    };
    expect(await verdict('archon-build-queue')).toBeNull();
    expect(await verdict('factory-app-check')).toBe('FAIL');
  } finally {
    await db.query('ROLLBACK');
  }
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

test('the factory row counts the work items a merged pull request closed or named with Refs', async () => {
  const [factory] = (await run<BoardRow>('board', 'mission-control')).filter(
    (r) => r.kind === 'factory',
  );
  expect(factory).toMatchObject({
    repository: 'coleam00/factory-mission-control',
    merged_total: 9,
  });
});

test('a Refs-delivered item is merged unless closed as not planned or a duplicate, and an open Refs pull request is not its pull request', async () => {
  const board = async () =>
    (await run<BoardRow>('board', 'mission-control')).filter((r) => r.kind === 'item');
  const mergedTotal = async () =>
    (await run<BoardRow>('board', 'mission-control')).find((r) => r.kind === 'factory')
      ?.merged_total;
  const setReason = (number: number, reason: string | null) =>
    db.query(
      `UPDATE mc.issues SET close_reason = $2 WHERE factory = 'mission-control' AND number = $1`,
      [number, reason],
    );
  expect((await board()).find((r) => r.number === 4)).toMatchObject({ state: 'closed', pr: null });
  const [{ merged_at: mergedAt }] = (await db.query(
    `SELECT merged_at FROM mc.pull_requests WHERE factory = 'mission-control' AND number = 103`,
  )) as unknown as { merged_at: string }[];
  try {
    await db.query(
      `INSERT INTO mc.pull_requests (factory, number, title, state, merged_at, head_sha, url, created_at, updated_at)
       VALUES ('mission-control', 9101, 't', 'open', NULL, 'h', 'u', now(), now())`,
    );
    await db.query(
      `INSERT INTO mc.pull_request_references (factory, pr_number, issue_number) VALUES ('mission-control', 9101, 13)`,
    );
    expect((await board()).find((r) => r.number === 13)).toMatchObject({ pr: null, pr_open: null });
    const columns = (await view('mission-control')).columns;
    expect(columns.some((c) => c.items.some((i) => i.number === 13))).toBe(false);

    for (const reason of ['not_planned', 'duplicate']) {
      await setReason(4, reason);
      expect((await board()).some((r) => r.number === 4)).toBe(false);
      expect(await mergedTotal()).toBe(8);
    }
    await setReason(4, null);
    expect((await board()).some((r) => r.number === 4)).toBe(true);
    expect(await mergedTotal()).toBe(9);

    await setReason(10, 'not_planned');
    expect((await board()).some((r) => r.number === 10)).toBe(false);

    await db.query(
      `UPDATE mc.pull_requests SET merged_at = NULL WHERE factory = 'mission-control' AND number = 103`,
    );
    expect((await board()).some((r) => r.number === 4)).toBe(false);
    expect(await mergedTotal()).toBe(6);
  } finally {
    await db.query(
      `UPDATE mc.pull_requests SET merged_at = $1 WHERE factory = 'mission-control' AND number = 103`,
      [mergedAt],
    );
    await setReason(10, 'completed');
    await setReason(4, 'completed');
    await db.query(`DELETE FROM mc.pull_request_references WHERE pr_number = 9101`);
    await db.query(
      `DELETE FROM mc.pull_requests WHERE factory = 'mission-control' AND number = 9101`,
    );
  }
});
