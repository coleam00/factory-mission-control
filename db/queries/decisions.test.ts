import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Db } from '../../scripts/lib/db';
import { onTheSeed, queries } from './test-seed';

const query = (name: string) => queries.find(([n]) => n === name)?.[1] as string;
const ATTENTION = query('attention-items');

describe('the attention-items query on the seed', () => {
  let db: Db;
  const FACTORY = ['mission-control'];

  beforeAll(async () => {
    db = await onTheSeed();
  }, 60_000);
  afterAll(() => db.close());

  test('attention-items is the seeded runs paused on an attention wait, with the console', async () => {
    const rows = await db.query(ATTENTION, FACTORY);
    expect(
      rows.map((r) => [r.run_id, r.workflow_name, r.node_id, r.form, r.labels, r.console]).sort(),
    ).toEqual([
      [
        '5eed0005-0000-4000-8000-000000000001',
        'archon-build-queue',
        'ask',
        'select',
        '{"build": "scope"}',
        'http://localhost:3090',
      ],
      [
        '5eed0005-0000-4000-8000-000000000002',
        'archon-merge-queue',
        'ask',
        'select',
        '{"merge": "pr"}',
        'http://localhost:3090',
      ],
    ]);
    expect(await db.query(ATTENTION, ['second-factory'])).toEqual([]);
  });
});
