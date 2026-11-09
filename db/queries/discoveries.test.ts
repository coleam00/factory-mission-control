import { afterAll, beforeAll, expect, test } from 'bun:test';
import { type DiscoveryRow, found } from '../../app/lib/board';
import type { Db } from '../../scripts/lib/db';
import { onTheSeed, queries } from './test-seed';

const sql = queries.find(([name]) => name === 'discoveries')?.[1] as string;

let db: Db;
beforeAll(async () => {
  db = await onTheSeed();
}, 60_000);
afterAll(() => db.close());

const RUN = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

async function lap(n: number, factory: string, status: 'completed' | 'running', output: unknown) {
  await db.query(
    `INSERT INTO mc.laps (run_id, factory, workflow_name, status) VALUES ($1, $2, 'archon-discoveries', 'completed')`,
    [RUN(n), factory],
  );
  await db.query(
    `INSERT INTO mc.lap_steps (run_id, step_id, status, output) VALUES ($1, 'outcome', $2, $3::jsonb)`,
    [RUN(n), status, JSON.stringify(output)],
  );
}

test("the query returns this factory's finished outcome steps, and found counts what they filed, tracked and dropped", async () => {
  const decided = {
    written: [
      { key: 'a', outcome: 'file', url: 'u1' },
      { key: 'b', outcome: 'track', url: 'u2' },
    ],
    dropped: [{ key: 'c' }],
  };
  await lap(901, 'mission-control', 'completed', decided);
  await lap(902, 'mission-control', 'running', decided);
  await lap(903, 'queue-factory', 'completed', decided);
  const rows = (await db.query(sql, ['mission-control'])) as unknown as DiscoveryRow[];
  expect(rows.map((r) => r.run_id)).toEqual([RUN(901)]);
  expect(found(rows)).toEqual({ filed: 1, tracked: 1, dropped: 1 });
});
