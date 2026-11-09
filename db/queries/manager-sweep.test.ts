import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Db } from '../../scripts/lib/db';
import { onTheSeed, queries } from './test-seed';

const SWEEP = queries.find(([n]) => n === 'manager-sweep')?.[1] as string;

describe('the manager-sweep query', () => {
  let db: Db;

  beforeAll(async () => {
    db = await onTheSeed();
  }, 60_000);
  afterAll(() => db.close());

  const lap = (
    id: string,
    status: string,
    completedAt: string | null,
    workflow = 'factory-manager',
    factory = 'queue-factory',
  ) =>
    db.query(
      `INSERT INTO mc.laps (run_id, factory, workflow_name, status, started_at, completed_at)
       VALUES ($1, $5, $2, $3, '2026-10-24T08:00:00Z', $4)`,
      [id, workflow, status, completedAt, factory],
    );

  test('answers with null when the factory has no finished manager run', async () => {
    await lap('5eed0009-0000-4000-8000-000000000001', 'running', null);
    await lap(
      '5eed0009-0000-4000-8000-000000000002',
      'completed',
      '2026-10-24T09:00:00Z',
      'archon-intake',
    );
    const rows = await db.query(SWEEP, ['queue-factory']);
    expect(rows.map((r) => r.swept_at)).toEqual([null]);
  });

  test('answers with the completion time of the last finished manager run', async () => {
    await lap('5eed0009-0000-4000-8000-000000000003', 'completed', '2026-10-24T09:30:00Z');
    await lap('5eed0009-0000-4000-8000-000000000004', 'completed', '2026-10-24T10:15:00Z');
    await lap('5eed0009-0000-4000-8000-000000000005', 'failed', '2026-10-24T11:00:00Z');
    await lap(
      '5eed0009-0000-4000-8000-000000000006',
      'completed',
      '2026-10-24T12:00:00Z',
      'factory-manager',
      'other-factory',
    );
    const rows = await db.query(SWEEP, ['queue-factory']);
    expect(rows.map((r) => new Date(String(r.swept_at)).toISOString())).toEqual([
      '2026-10-24T10:15:00.000Z',
    ]);
  });
});
