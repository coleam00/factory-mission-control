import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Db } from '../../scripts/lib/db';
import { onTheSeed, queries } from './test-seed';

const MANAGER_HANDLED = queries.find(([n]) => n === 'manager-handled')?.[1] as string;
const run = (n: number) => `5eed0000-0000-4000-8000-0000000000f${n}`;

describe('the manager-handled query', () => {
  let db: Db;

  beforeAll(async () => {
    db = await onTheSeed();
  }, 60_000);
  afterAll(() => db.close());

  const managerRun = async (
    n: number,
    factory: string,
    output: unknown,
    status = 'completed',
    workflow = 'factory-manager',
  ) => {
    await db.query(
      `INSERT INTO mc.laps (run_id, factory, workflow_name, status, started_at, completed_at)
       VALUES ($1, $2, $3, $4, $5, $5)`,
      [run(n), factory, workflow, status, `2026-10-10T0${n}:00:00Z`],
    );
    await db.query(
      `INSERT INTO mc.lap_steps (run_id, step_id, status, output) VALUES ($1, 'manage', 'completed', $2)`,
      [run(n), JSON.stringify(output)],
    );
  };

  test('counts what each completed manager run answered, newest first, and ignores the rest', async () => {
    await managerRun(1, 'mission-control', { answered: ['#1', '#2'] });
    await managerRun(2, 'mission-control', { answered: [] });
    await managerRun(3, 'mission-control', { answered: 'none' });
    await managerRun(4, 'mission-control', { answered: ['#3'] });
    await managerRun(5, 'mission-control', { answered: ['#4'] }, 'failed');
    await managerRun(6, 'mission-control', { answered: ['#5'] }, 'completed', 'archon-loop');
    await managerRun(7, 'other-factory', { answered: ['#6'] });
    const rows = await db.query(MANAGER_HANDLED, ['mission-control']);
    expect(rows.map((r) => [r.run_id, r.answered])).toEqual([
      [run(4), 1],
      [run(1), 2],
    ]);
  });
});
