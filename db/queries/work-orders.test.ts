import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { WorkOrderRow } from '../../app/map/live';
import type { Db } from '../../scripts/lib/db';
import { onTheSeed, queries } from './test-seed';

const sql = queries.find(([name]) => name === 'work-orders')?.[1] as string;

let db: Db;
beforeAll(async () => {
  db = await onTheSeed();
}, 60_000);
afterAll(() => db.close());

const label = (issue: number, name: string, factory = 'mission-control') =>
  db.query('INSERT INTO mc.issue_labels (factory, issue_number, label) VALUES ($1, $2, $3)', [
    factory,
    issue,
    name,
  ]);
const orders = async () =>
  ((await db.query(sql, ['mission-control'])) as unknown as WorkOrderRow[]).filter((o) =>
    ['combat', 'polish'].includes(o.name),
  );

test('a work order is listed with its counts and where it lands, and stays after its last issue closes', async () => {
  expect(await orders()).toEqual([]);
  const open = (await db.query(
    `SELECT number FROM mc.issues WHERE factory = 'mission-control' AND state = 'open' ORDER BY number LIMIT 2`,
  )) as { number: number }[];
  const closed = (await db.query(
    `SELECT number FROM mc.issues WHERE factory = 'mission-control' AND state = 'closed' ORDER BY number LIMIT 1`,
  )) as { number: number }[];
  const [a, b] = open.map((r) => r.number) as [number, number];
  const [done] = closed.map((r) => r.number) as [number];
  await label(a, 'work-order:combat');
  await label(b, 'work-order:combat');
  await label(a, 'lands-on:staging');
  await label(done, 'work-order:combat');
  await label(done, 'work-order:polish');
  await db.query(
    `INSERT INTO mc.pull_requests (factory, number, title, state, merged_at, head_sha, url, created_at, updated_at)
     VALUES ('mission-control', 9001, 'p', 'closed', now(), 'x', 'u', now(), now())`,
  );
  await db.query(
    `INSERT INTO mc.pull_request_issues (factory, pr_number, issue_number) VALUES ('mission-control', 9001, $1)`,
    [done],
  );
  await db.query(
    `INSERT INTO mc.issues (factory, number, title, state, url, created_at, updated_at)
     VALUES ('other-factory', $1, 't', 'open', 'u', now(), now())`,
    [a],
  );
  await label(a, 'work-order:combat', 'other-factory');
  await label(a, 'work-order:elsewhere', 'other-factory');
  await label(a, 'lands-on:production', 'other-factory');
  expect(await orders()).toEqual([
    {
      name: 'combat',
      total_count: 3,
      open_count: 2,
      done_count: 1,
      merged_count: 1,
      lands_on: 'staging',
      last_closed_at: expect.anything(),
    },
    {
      name: 'polish',
      total_count: 1,
      open_count: 0,
      done_count: 1,
      merged_count: 1,
      lands_on: null,
      last_closed_at: expect.anything(),
    },
  ]);
  await db.query(
    `UPDATE mc.issues SET state = 'closed', closed_at = '2026-11-01T00:00:00Z'
      WHERE factory = 'mission-control' AND number IN ($1, $2)`,
    [a, b],
  );
  expect(await orders()).toMatchObject([
    { name: 'combat', open_count: 0, last_closed_at: new Date('2026-11-01T00:00:00Z') },
    { name: 'polish', open_count: 0 },
  ]);
});

test('a work order counts an issue a merged pull request names with Refs, never one closed as not planned or a duplicate', async () => {
  const refs = async () =>
    ((await db.query(sql, ['mission-control'])) as unknown as WorkOrderRow[]).find(
      (o) => o.name === 'refs',
    );
  const setReason = (reason: string | null) =>
    db.query(
      `UPDATE mc.issues SET close_reason = $1 WHERE factory = 'mission-control' AND number = 4`,
      [reason],
    );
  const [{ merged_at: mergedAt }] = (await db.query(
    `SELECT merged_at FROM mc.pull_requests WHERE factory = 'mission-control' AND number = 103`,
  )) as unknown as { merged_at: string }[];
  await label(4, 'work-order:refs');
  try {
    expect(await refs()).toMatchObject({ total_count: 1, merged_count: 1 });
    for (const reason of ['not_planned', 'duplicate']) {
      await setReason(reason);
      expect(await refs()).toMatchObject({ total_count: 0, merged_count: 0 });
    }
    await setReason(null);
    expect(await refs()).toMatchObject({ total_count: 1, merged_count: 1 });

    await db.query(
      `UPDATE mc.pull_requests SET merged_at = NULL WHERE factory = 'mission-control' AND number = 103`,
    );
    expect(await refs()).toMatchObject({ total_count: 1, merged_count: 0 });
  } finally {
    await db.query(
      `DELETE FROM mc.issue_labels WHERE factory = 'mission-control' AND label = 'work-order:refs'`,
    );
    await db.query(
      `UPDATE mc.pull_requests SET merged_at = $1 WHERE factory = 'mission-control' AND number = 103`,
      [mergedAt],
    );
    await setReason('completed');
  }
});

test('a work order counts done the issues closed as completed, by hand or by a merged pull request, and leaves out those closed as not planned or a duplicate', async () => {
  const order = async () =>
    ((await db.query(sql, ['mission-control'])) as unknown as WorkOrderRow[]).find(
      (o) => o.name === 'tally',
    );
  const numbers = (
    (await db.query(
      `SELECT number FROM mc.issues WHERE factory = 'mission-control' ORDER BY number LIMIT 3`,
    )) as { number: number }[]
  ).map((r) => r.number) as [number, number, number];
  const close = (issue: number, reason: string | null) =>
    db.query(
      `UPDATE mc.issues SET state = 'closed', close_reason = $2, closed_at = now()
        WHERE factory = 'mission-control' AND number = $1`,
      [issue, reason],
    );
  const before = (await db.query(
    `SELECT number, state, close_reason, closed_at FROM mc.issues
      WHERE factory = 'mission-control' AND number = ANY($1)`,
    [numbers],
  )) as { number: number; state: string; close_reason: string | null; closed_at: Date | null }[];
  for (const n of numbers) await label(n, 'work-order:tally');
  try {
    await db.query(
      `UPDATE mc.issues SET state = 'open', close_reason = NULL, closed_at = NULL
        WHERE factory = 'mission-control' AND number = ANY($1)`,
      [numbers],
    );
    expect(await order()).toMatchObject({ total_count: 3, done_count: 0 });
    await close(numbers[0], 'not_planned');
    expect(await order()).toMatchObject({ total_count: 2, done_count: 0, open_count: 2 });
    await close(numbers[1], 'completed');
    expect(await order()).toMatchObject({ total_count: 2, done_count: 1, open_count: 1 });
    await close(numbers[2], 'duplicate');
    expect(await order()).toMatchObject({ total_count: 1, done_count: 1, open_count: 0 });
    await close(numbers[2], 'completed');
    expect(await order()).toMatchObject({ total_count: 2, done_count: 2, open_count: 0 });
  } finally {
    await db.query(
      `DELETE FROM mc.issue_labels WHERE factory = 'mission-control' AND label = 'work-order:tally'`,
    );
    for (const r of before)
      await db.query(
        `UPDATE mc.issues SET state = $2, close_reason = $3, closed_at = $4
          WHERE factory = 'mission-control' AND number = $1`,
        [r.number, r.state, r.close_reason, r.closed_at],
      );
  }
});
