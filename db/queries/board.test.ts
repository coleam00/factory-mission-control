import { afterAll, beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { type BoardRow, boardView, type DiscoveryRow } from '../../app/lib/board';
import type { HealthWorkableRow } from '../../app/lib/health';
import type { OwnerQueueRow } from '../../app/lib/owner-queue';
import { runsArgs } from '../../app/lib/runs';
import { FACTORY_MAP } from '../../app/map/factory-map';
import { cardLive, type HomeMapRow, type WorkOrderRow } from '../../app/map/live';
import { QUEUE_PARKED, QUEUE_UNSTICK } from '../../scripts/fixture/seed';
import type { Db } from '../../scripts/lib/db';
import { onTheSeed, queries } from './test-seed';

// The parked items the Unstick fixture adds: work item rows the Board reads like 413's.
const UNSTICK_PARKED = [QUEUE_UNSTICK.parkedMerged.issue, QUEUE_UNSTICK.parkedOpen.issue];

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
      discoveries: await run<DiscoveryRow>('discoveries', factory),
    },
    NOW,
    order,
  );
}

test('the seed recount: each column and each work order bar equal the definitions', async () => {
  const columns = (v: Awaited<ReturnType<typeof view>>) =>
    Object.fromEntries(v.columns.map((c) => [c.id, c.items.map((i) => i.number)]));
  // mission-control at NOW. Open, by the rules in order: 9 has an open pull request and no run (Build,
  // waiting for a run); 11 runs `build` (Build); 12 runs `check-app` (App check). 13 has a round
  // (Build); 14 to 16 have no run, no round and are not workable (Intake). 10 closed on 2026-10-20, inside
  // 7 days (Merged); the other merged-closed items (1, 2, 3, 5, 6, 7, 8) and 4, closed as completed
  // after #103 named it with `Refs`, are older.
  const mission = await view('mission-control');
  expect(columns(mission)).toEqual({
    queued: [],
    intake: [14, 15, 16],
    build: [9, 11, 13],
    review: [],
    app: [12],
    merge: [],
    decision: [],
    merged: [10],
    parked: [],
  });
  expect(mission.older).toBe(8);
  // foundations holds 5, 6, 7 (merged) and 9 (open); screens holds 10 (merged), 11, 12 and 14.
  expect(mission.orders).toMatchObject([
    { name: 'foundations', merged: 3, total: 4, landsOn: 'main' },
    { name: 'screens', merged: 1, total: 4, landsOn: 'staging' },
  ]);
  // The filter narrows the columns to the order, and leaves the panels.
  const screens = await view('mission-control', 'screens');
  expect(columns(screens)).toMatchObject({ build: [11], app: [12], merged: [10] });
  expect(screens.orders).toEqual(mission.orders);

  // queue-factory: 401 is in triage and built (the build run is between steps), so Intake; 402 and
  // 403 only have runs between steps, so Intake with 406; 404 and 405 are workable with no run (Queued);
  // 410's running split run holds nothing, so it is Queued too, which makes 10 not in order, with 402, 403 and 406, plus the
  // two parked items of the Unstick fixture;
  // 406 is needs-owner, which a queue factory does not read, and is not workable. 410 is a product
  // document, 411 and 412 are its merged pieces and 413 its open one. 413's work item state says
  // its build was parked after its triage, so it is Parked, not Queued, and not workable either.
  const queue = await view('queue-factory');
  expect(columns(queue)).toEqual({
    queued: [404, 405, 410],
    intake: [401, 402, 403, 406],
    build: [],
    review: [],
    app: [],
    merge: [],
    decision: [],
    merged: [411, 412],
    parked: [413, ...UNSTICK_PARKED, 450, 452].sort((a, b) => a - b),
  });
  // The Unstick fixture's two stage-blocked items (450, 452) are in the Parked column and the wide card.
  const blocked = [QUEUE_UNSTICK.blockedMerged.issue, QUEUE_UNSTICK.blockedOpen.issue];
  expect(queue.notInOrder).toBe(10 + UNSTICK_PARKED.length + blocked.length);
  // The Pipeline holds every placed item once, and "Blocked and parked" holds the parked and blocked ones.
  const homes = queue.pipeline.flatMap((s) => s.items.map((i) => i.number));
  expect(new Set(homes).size).toBe(homes.length);
  expect(homes.length).toBe(queue.notInOrder);
  const wide = queue.pipeline.find((s) => s.id === 'blocked')?.items.map((i) => i.number);
  expect(wide).toEqual([413, ...UNSTICK_PARKED, ...blocked].sort((a, b) => a - b));
  expect(queue.pipeline.find((s) => s.id === 'merged')?.items.length).toBe(
    queue.columns.find((c) => c.id === 'merged')?.items.length,
  );
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

test('a queue run that names its item only in its facts step counts as a round', async () => {
  const rows = await run<BoardRow>('board', 'queue-factory');
  expect(rows.find((r) => r.number === 412)).toMatchObject({ rounds: 1 });
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

test('an item with two route labels shows the route the work item page reads', async () => {
  await db.query(
    `INSERT INTO mc.issue_labels (factory, issue_number, label, labeled_at)
     VALUES ('mission-control', 13, 'archon-investigate', now()), ('mission-control', 13, 'archon-ready', now())`,
  );
  try {
    const rows = await run<BoardRow>('board', 'mission-control');
    expect(rows.find((r) => r.number === 13)?.route).toBe('deliver');
  } finally {
    await db.query(
      `DELETE FROM mc.issue_labels WHERE factory = 'mission-control' AND issue_number = 13 AND label IN ('archon-investigate', 'archon-ready')`,
    );
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

test('a work item state reaches only the factory whose codebase it names', async () => {
  const parkedOf = async (factory: string) =>
    (await run<BoardRow>('board', factory))
      .filter((r) => r.kind === 'item' && r.build_status === 'parked')
      .map((r) => r.number);
  expect(await parkedOf('queue-factory')).toEqual([...UNSTICK_PARKED, 413]);
  expect(await parkedOf('mission-control')).toEqual([]);
  await db.query(
    `INSERT INTO mc.work_item_states (project_key, number, revision, build_status, build_at)
     SELECT codebase, 9, 1, 'parked', '2026-10-24T09:06:00.000Z' FROM mc.factories WHERE name = 'mission-control'`,
  );
  try {
    expect(await parkedOf('queue-factory')).toEqual([...UNSTICK_PARKED, 413]);
    expect(await parkedOf('mission-control')).toEqual([9]);
  } finally {
    await db.query(`DELETE FROM mc.work_item_states WHERE number = 9`);
  }
});

test("another factory's parked work item does not make this factory's issue unworkable", async () => {
  await db.query(
    `INSERT INTO mc.work_item_states (project_key, number, revision, build_status, build_at)
     SELECT codebase, 404, 1, 'parked', '2026-10-24T09:06:00.000Z' FROM mc.factories WHERE name = 'mission-control'`,
  );
  try {
    const workable = (await run<HealthWorkableRow>('health-workable', 'queue-factory')).map(
      (r) => r.issue_number,
    );
    expect(workable).toContain(404);
  } finally {
    await db.query(`DELETE FROM mc.work_item_states WHERE number = 404`);
  }
});

test('a parked work item is not workable, and a re-triage makes it workable again', async () => {
  const workable = async () =>
    (await run<HealthWorkableRow>('health-workable', 'queue-factory'))
      .flatMap((r) => (r.kind === 'issue' && r.issue_number !== null ? [r.issue_number] : []))
      .sort();
  const parkedItems = async () =>
    (await view('queue-factory')).columns
      .find((c) => c.id === 'parked')
      ?.items.map((i) => i.number);
  expect(await workable()).toEqual([404, 405, 410]);
  expect(await parkedItems()).toEqual(
    [QUEUE_PARKED.issue, ...UNSTICK_PARKED, 450, 452].sort((a, b) => a - b),
  );
  try {
    await db.query(
      `UPDATE mc.work_item_states SET triage_at = '2026-10-24T10:00:00.000Z', revision = revision + 1
       WHERE number = $1`,
      [QUEUE_PARKED.issue],
    );
    expect(await workable()).toContain(QUEUE_PARKED.issue);
    expect(await parkedItems()).toEqual([...UNSTICK_PARKED, 450, 452].sort((a, b) => a - b));
  } finally {
    await db.query(
      `UPDATE mc.work_item_states SET triage_at = $2, revision = $3 WHERE number = $1`,
      [QUEUE_PARKED.issue, QUEUE_PARKED.triagedAt, QUEUE_PARKED.revision],
    );
  }
});

test('a run that has just taken a work item is running on the Board, here on the map Build card, and on Laps', async () => {
  const runId = '5eed0491-0000-4000-8000-000000000001';
  const item = { repo: { host: 'github.com', path: 'coleam00/queue-factory' }, number: 404 };
  await db.query('BEGIN');
  try {
    await db.query(
      `INSERT INTO mc.laps (run_id, factory, workflow_name, status, started_at)
       VALUES ($1, 'queue-factory', 'archon-build-queue', 'running', '2026-10-25T11:50:00Z')`,
      [runId],
    );
    for (const [step, status, output] of [
      ['blocked', 'completed', null],
      ['facts', 'completed', { path: 'route', item }],
      ['route', 'running', null],
    ] as const) {
      await db.query(
        `INSERT INTO mc.lap_steps (run_id, step_id, status, started_at, output)
         VALUES ($1, $2, $3, '2026-10-25T11:51:00Z', $4)`,
        [runId, step, status, output === null ? null : JSON.stringify(output)],
      );
    }

    const board = await view('queue-factory');
    const column = (id: string) => board.columns.find((c) => c.id === id)?.items ?? [];
    expect(column('queued').map((i) => i.number)).not.toContain(404);
    expect(column('build').find((i) => i.number === 404)?.chips).toContainEqual(
      expect.objectContaining({ kind: 'round', state: 'running' }),
    );

    const live = cardLive(
      FACTORY_MAP,
      {
        map: await run<HomeMapRow>('home-map', 'queue-factory', ''),
        workable: await run<HealthWorkableRow>('health-workable', 'queue-factory'),
      },
      NOW,
    ).get('build');
    expect(live?.here.map((l) => l.issue?.number)).toContain(404);
    expect(live?.queued?.map((i) => i.number)).toEqual([405, 410]);

    const laps = await run<{ issue_number: number | null; step_id: string }>(
      'runs',
      'queue-factory',
      ...runsArgs({ q: '', state: '', hideIdle: false, page: 1 }),
    );
    expect(laps.find((l) => (l as unknown as { run_id: string }).run_id === runId)).toMatchObject({
      issue_number: 404,
      step_id: 'route',
    });
  } finally {
    await db.query('ROLLBACK');
  }
});

test('an item a paused run waits on holds only by its claim or its facts step is on its run card with Needs you', async () => {
  const waiting = [
    { run: '5eed0715-0000-4000-8000-000000000001', item: 404, by: 'claim' },
    { run: '5eed0715-0000-4000-8000-000000000002', item: 405, by: 'facts' },
  ] as const;
  await db.query('BEGIN');
  try {
    for (const { run: runId, item, by } of waiting) {
      await db.query(
        `INSERT INTO mc.laps (run_id, factory, workflow_name, status, started_at, attention_open)
         VALUES ($1, 'queue-factory', 'archon-build-queue', 'paused', '2026-10-25T11:50:00Z', true)`,
        [runId],
      );
      if (by === 'claim')
        await db.query(
          `INSERT INTO mc.claims (factory, issue_number, run_id, claimed_at)
           VALUES ('queue-factory', $1, $2, '2026-10-25T11:50:00Z')`,
          [item, runId],
        );
      else
        await db.query(
          `INSERT INTO mc.lap_steps (run_id, step_id, status, started_at, output)
           VALUES ($1, 'facts', 'completed', '2026-10-25T11:51:00Z', $2)`,
          [
            runId,
            JSON.stringify({
              item: { repo: { host: 'github.com', path: 'coleam00/queue-factory' }, number: item },
            }),
          ],
        );
    }
    const board = await view('queue-factory');
    const decision = board.columns.find((c) => c.id === 'decision')?.items.map((i) => i.number);
    expect(decision).toEqual(expect.arrayContaining([404, 405]));
  } finally {
    await db.query('ROLLBACK');
  }
});

const missionItem = async (number: number) =>
  (await run<BoardRow>('board', 'mission-control')).find((r) => r.number === number);

test("a work item's rounds are Archon's finished rounds, and the run count only stands in without a state", async () => {
  expect(await missionItem(9)).toMatchObject({ rounds: 3, round_list: null, returns: null });
  await db.query(
    `INSERT INTO mc.work_item_states (project_key, number, revision, rounds, returns, last_decision)
     SELECT codebase, 9, 1, '[{"at":"a","reason":"ask","reviews":0,"run_id":"r1"},{"at":"b","reason":"delivered","reviews":2,"run_id":"r2"}]',
       3, 'returned by the merge queue' FROM mc.factories WHERE name = 'mission-control'`,
  );
  try {
    const row = await missionItem(9);
    expect(row).toMatchObject({
      rounds: 2,
      returns: 3,
      last_decision: 'returned by the merge queue',
    });
    expect(JSON.parse(row?.round_list ?? 'null')).toEqual([
      { at: 'a', reason: 'ask', reviews: 0, run_id: 'r1' },
      { at: 'b', reason: 'delivered', reviews: 2, run_id: 'r2' },
    ]);
  } finally {
    await db.query(`DELETE FROM mc.work_item_states WHERE number = 9`);
  }
});

test('a Refs-only item takes its pull request from the projection, with its head and app check head', async () => {
  await db.query(
    `INSERT INTO mc.pull_requests (factory, number, title, state, merged_at, head_sha, url, created_at, updated_at)
     VALUES ('mission-control', 9102, 't', 'open', NULL, 'abc123', 'u', now(), now())`,
  );
  await db.query(
    `INSERT INTO mc.work_item_states (project_key, number, revision, pr_number)
     SELECT codebase, 13, 1, 9102 FROM mc.factories WHERE name = 'mission-control'`,
  );
  await db.query('BEGIN');
  try {
    expect(await missionItem(13)).toMatchObject({
      pr: 9102,
      pr_open: null,
      pr_head: 'abc123',
      app_check_head: null,
      app_check_run: null,
    });
    const runId = '5eed0700-0000-4000-8000-000000000001';
    await db.query(
      `INSERT INTO mc.laps (run_id, factory, workflow_name, status, started_at)
       VALUES ($1, 'mission-control', 'factory-app-check', 'running', '2026-10-25T11:50:00Z')`,
      [runId],
    );
    await db.query(
      `INSERT INTO mc.lap_steps (run_id, step_id, status, started_at, output) VALUES
       ($1, 'select', 'completed', '2026-10-25T11:50:00Z', '{"pr":9102}')`,
      [runId],
    );
    expect(await missionItem(13)).toMatchObject({ app_check_run: runId });
    await db.query(`UPDATE mc.laps SET status = 'completed' WHERE run_id = $1`, [runId]);
    await db.query(
      `INSERT INTO mc.lap_steps (run_id, step_id, status, started_at, output)
       VALUES ($1, 'check', 'completed', '2026-10-25T11:51:00Z', '{"pr":9102,"head":"abc123","overall":"PASS"}')`,
      [runId],
    );
    expect(await missionItem(13)).toMatchObject({
      app_check_run: null,
      app_check: 'PASS',
      app_check_head: 'abc123',
    });
  } finally {
    await db.query('ROLLBACK');
    await db.query(`DELETE FROM mc.work_item_states WHERE number = 13`);
    await db.query(
      `DELETE FROM mc.pull_requests WHERE factory = 'mission-control' AND number = 9102`,
    );
  }
});

test('a Refs-only item whose projected pull request merged reads it, with its merge time', async () => {
  await db.query(
    `INSERT INTO mc.pull_requests (factory, number, title, state, merged_at, head_sha, url, created_at, updated_at)
     VALUES ('mission-control', 9104, 't', 'closed', '2026-03-04T05:06:07.089Z', 'merged1', 'u', now(), now())`,
  );
  await db.query(
    `INSERT INTO mc.work_item_states (project_key, number, revision, pr_number)
     SELECT codebase, 13, 1, 9104 FROM mc.factories WHERE name = 'mission-control'`,
  );
  try {
    expect(await missionItem(13)).toMatchObject({
      pr: 9104,
      pr_open: null,
      pr_head: 'merged1',
      merged_at: '2026-03-04T05:06:07.089Z',
    });
  } finally {
    await db.query(`DELETE FROM mc.work_item_states WHERE number = 13`);
    await db.query(
      `DELETE FROM mc.pull_requests WHERE factory = 'mission-control' AND number = 9104`,
    );
  }
});

test('merged_at is the merge fact’s time, else the merged pull request’s', async () => {
  expect(await missionItem(10)).toMatchObject({ pr: 110, merged_at: '2026-10-20T09:30:00.000Z' });
  expect(await missionItem(9)).toMatchObject({ merged_at: null });
  await db.query(
    `INSERT INTO mc.work_item_states (project_key, number, revision, merge_status, merge_at)
     SELECT codebase, 10, 1, 'merged', '2026-10-20T08:00:00.000Z' FROM mc.factories WHERE name = 'mission-control'`,
  );
  try {
    expect(await missionItem(10)).toMatchObject({ merged_at: '2026-10-20T08:00:00.000Z' });
  } finally {
    await db.query(`DELETE FROM mc.work_item_states WHERE number = 10`);
  }
});

test('merged_at is null for a merge that a later build or triage has overtaken, next to an open pull request', async () => {
  const state = (build: string | null, triage: string | null) =>
    db.query(
      `INSERT INTO mc.work_item_states (project_key, number, revision, merge_status, merge_at, build_at, triage_at)
       SELECT codebase, 9, 1, 'merged', '2026-11-01T00:00:00.000Z', $1, $2 FROM mc.factories WHERE name = 'mission-control'
       ON CONFLICT (project_key, number) DO UPDATE SET build_at = $1, triage_at = $2`,
      [build, triage],
    );
  try {
    await state('2026-11-05T00:00:00.000Z', '2026-11-04T00:00:00.000Z');
    expect(await missionItem(9)).toMatchObject({ pr_open: true, merged_at: null });
    await state(null, '2026-11-04T00:00:00.000Z');
    expect(await missionItem(9)).toMatchObject({ merged_at: null });
    await state('2026-11-01T00:00:00.000Z', null);
    expect(await missionItem(9)).toMatchObject({
      pr_open: true,
      merged_at: '2026-11-01T00:00:00.000Z',
    });
  } finally {
    await db.query(`DELETE FROM mc.work_item_states WHERE number = 9`);
  }
});

test('one pull request answers pr, pr_head and merged_at: open linked, else projected, else merged linked', async () => {
  const fixtures = async (factory: string) => {
    await db.query(
      `INSERT INTO mc.pull_requests (factory, number, title, state, merged_at, head_sha, url, created_at, updated_at)
       VALUES ($1, 9102, 't', 'open', NULL, 'projected', 'u', now(), now()),
         ($1, 9103, 't', 'open', NULL, 'linked', 'u', now(), now())`,
      [factory],
    );
    await db.query(
      `INSERT INTO mc.work_item_states (project_key, number, revision, pr_number)
       SELECT codebase, 10, 1, 9102 FROM mc.factories WHERE name = $1`,
      [factory],
    );
  };
  await fixtures('mission-control');
  try {
    // Item 10: a merged closing pull request, and a later round's open one.
    expect(await missionItem(10)).toMatchObject({
      pr: 9102,
      pr_head: 'projected',
      pr_open: false,
      merged_at: null,
    });
    await db.query(
      `INSERT INTO mc.pull_request_issues (factory, pr_number, issue_number) VALUES ('mission-control', 9103, 10)`,
    );
    expect(await missionItem(10)).toMatchObject({
      pr: 9103,
      pr_head: 'linked',
      pr_open: true,
      merged_at: null,
    });
  } finally {
    await db.query(`DELETE FROM mc.pull_request_issues WHERE pr_number = 9103`);
    await db.query(`DELETE FROM mc.work_item_states WHERE number = 10`);
    await db.query(
      `DELETE FROM mc.pull_requests WHERE factory = 'mission-control' AND number IN (9102, 9103)`,
    );
  }
  expect(await missionItem(10)).toMatchObject({
    pr: 110,
    pr_open: false,
    merged_at: '2026-10-20T09:30:00.000Z',
  });
});

test('the board query stays fast when many runs have shipped', async () => {
  await db.query('BEGIN');
  try {
    await db.query(`INSERT INTO mc.factories VALUES ('scale-factory','o/sf','o/sf','c')`);
    await db.query(`INSERT INTO mc.issues (factory, number, title, state, url, created_at, updated_at)
      SELECT 'scale-factory', n, 't' || n, 'open', 'u', now(), now() FROM generate_series(1, 200) n`);
    await db.query(`INSERT INTO mc.laps (run_id, factory, workflow_name, status, started_at, issue_number)
      SELECT ('00000000-0000-4000-9000-' || lpad(k::text, 12, '0'))::uuid, 'scale-factory',
        'archon-loop', 'completed', now() - k * interval '1 minute', 1 + k % 200
      FROM generate_series(1, 1000) k`);
    await db.query(`INSERT INTO mc.lap_steps (run_id, step_id, status, started_at)
      SELECT ('00000000-0000-4000-9000-' || lpad(k::text, 12, '0'))::uuid, s, 'completed', now()
      FROM generate_series(1, 1000) k,
        LATERAL (SELECT 'ship' AS s UNION ALL SELECT 'ship__n' || j FROM generate_series(1, 20) j) st`);
    await db.query(`INSERT INTO mc.claims (factory, issue_number, run_id, claimed_at)
      SELECT 'scale-factory', 1 + k % 200, ('00000000-0000-4000-9000-' || lpad(k::text, 12, '0'))::uuid, now()
      FROM generate_series(1, 500) k`);
    await db.query('ANALYZE');

    const sql = queries.find(([n]) => n === 'board')?.[1] as string;
    const plan = (await db.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`, [
      'scale-factory',
    ])) as unknown as { 'QUERY PLAN': { 'Execution Time': number }[] }[];
    expect(plan[0]['QUERY PLAN'][0]['Execution Time']).toBeLessThan(1000);
  } finally {
    await db.query('ROLLBACK');
  }
}, 60_000);
