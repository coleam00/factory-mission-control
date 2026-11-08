import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { Db } from '../../scripts/lib/db';
import { onTheSeed, queries } from './test-seed';

let db: Db;
beforeAll(async () => {
  db = await onTheSeed();
});
afterAll(() => db.close());

const FACTORY = 'mission-control';
const sql = queries.find(([n]) => n === 'failure-groups')?.[1] as string;

test('on the seed every finished or failed run has a stop record, classed and signed when failed', async () => {
  expect(
    await db.query(`SELECT l.run_id FROM mc.laps l LEFT JOIN mc.run_stops s USING (run_id)
      WHERE l.status IN ('completed', 'failed') AND s.run_id IS NULL`),
  ).toEqual([]);
  expect(
    await db.query(`SELECT run_id FROM mc.run_stops
      WHERE status = 'failed' AND (class IS NULL OR signature IS NULL)`),
  ).toEqual([]);
});

test('failure-groups returns the factory’s failures as groups with 14 daily counts', async () => {
  const groups = await db.query(sql, [FACTORY]);
  const [{ failed } = { failed: 0 }] = await db.query(
    `SELECT count(*)::int AS failed FROM mc.run_stops WHERE factory = $1 AND status = 'failed'`,
    [FACTORY],
  );
  expect(groups.length).toBeGreaterThan(0);
  for (const g of groups) expect((g.daily as number[]).length).toBe(14);
  expect(groups.reduce((n, g) => n + Number(g.failures), 0)).toBe(Number(failed));
  const [{ inWindow } = { inWindow: 0 }] = await db.query(
    `SELECT count(*)::int AS "inWindow" FROM mc.run_stops
     WHERE factory = $1 AND status = 'failed'
       AND (stopped_at AT TIME ZONE 'UTC')::date > (SELECT max((stopped_at AT TIME ZONE 'UTC')::date) FROM mc.run_stops WHERE factory = $1 AND status = 'failed') - 14`,
    [FACTORY],
  );
  const daily = groups.reduce((n, g) => n + (g.daily as number[]).reduce((a, b) => a + b, 0), 0);
  expect(daily).toBe(Number(inWindow));
});

test('failure-groups orders daily oldest first and names the newest failure as the latest run', async () => {
  const day = (d: string) => new Date(`${d}T09:00:00Z`);
  const ids = ['aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000002'];
  await db.query(
    `INSERT INTO mc.run_stops (run_id, factory, workflow_name, status, step_id, line, class, signature, stopped_at)
    VALUES ($1, 'order-proof', 'w', 'failed', 's', 'old', 'code', 'sig', $3::timestamptz),
           ($2, 'order-proof', 'w', 'failed', 's', 'new', 'code', 'sig', $4::timestamptz)`,
    [ids[0], ids[1], day('2026-10-23').toISOString(), day('2026-10-25').toISOString()],
  );
  const [g] = await db.query(sql, ['order-proof']);
  expect(g?.daily).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1]);
  expect(new Date(g?.last_day as string).toISOString().slice(0, 10)).toBe('2026-10-25');
  expect(g?.latest_run_id).toBe(ids[1]);
});

test('failure-groups shows the latest run’s class, or mixed when the group’s runs differ', async () => {
  const row = (n: number, cls: string | null, day: string) =>
    db.query(
      `INSERT INTO mc.run_stops (run_id, factory, workflow_name, status, step_id, line, class, signature, stopped_at)
       VALUES ($1, $2, 'w', 'failed', 's', 'l', $3, $4, $5::timestamptz)`,
      [
        `bbbbbbbb-0000-4000-8000-00000000000${n}`,
        `class-proof`,
        cls,
        `sig-${n > 4 ? 'c' : n > 2 ? 'b' : 'a'}`,
        day,
      ],
    );
  await row(1, 'transient', '2026-10-23');
  await row(2, 'config', '2026-10-24');
  await row(3, 'code', '2026-10-24');
  await row(4, 'code', '2026-10-25');
  await row(5, null, '2026-10-24');
  await row(6, 'code', '2026-10-25');
  const groups = await db.query(sql, ['class-proof']);
  expect(Object.fromEntries(groups.map((g) => [g.signature, g.class]))).toEqual({
    'sig-a': 'mixed',
    'sig-b': 'code',
    'sig-c': 'mixed',
  });
});
