import { afterAll, beforeAll, expect, test } from 'bun:test';
import { onTheSeed, queries } from '../../db/queries/test-seed';
import type { Db } from '../lib/db';
import { seedLapHeaderSql } from './one-lap';

let db: Db;
beforeAll(async () => {
  db = await onTheSeed();
});
afterAll(() => db.close());

test("test:live's header query runs on every seed lap and reads what one-lap.sql reads", async () => {
  const oneLapSql = queries.find(([name]) => name === 'one-lap')?.[1] as string;
  const laps = await db.query('SELECT run_id, factory FROM mc.laps');
  expect(laps.length).toBeGreaterThan(0);
  for (const { run_id, factory } of laps) {
    const [read] = await db.query(oneLapSql, [factory, run_id]);
    const [shown] = await db.query(seedLapHeaderSql(oneLapSql), [run_id]);
    expect([shown.issue, shown.issue_url, shown.route, shown.pr_number], `lap ${run_id}`).toEqual([
      read.issue_number,
      read.issue_url,
      read.route,
      read.pr_number,
    ]);
  }
});
