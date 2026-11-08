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
       AND stopped_day > (SELECT max(stopped_day) FROM mc.run_stops WHERE factory = $1 AND status = 'failed') - 14`,
    [FACTORY],
  );
  const daily = groups.reduce((n, g) => n + (g.daily as number[]).reduce((a, b) => a + b, 0), 0);
  expect(daily).toBe(Number(inWindow));
});
