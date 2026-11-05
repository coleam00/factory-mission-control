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
      merged_count: 1,
      lands_on: 'staging',
      last_closed_at: expect.anything(),
    },
    {
      name: 'polish',
      total_count: 1,
      open_count: 0,
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
