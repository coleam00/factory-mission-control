import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { writeRow } from '../../scripts/fixture/write';
import type { Db } from '../../scripts/lib/db';
import { onTheSeed, queries } from './test-seed';

const query = (name: string) => queries.find(([n]) => n === name)?.[1] as string;
const ATTENTION = query('attention-items');
const COUNT = query('decisions-count');
const OWNER = query('owner-queue');

describe('the decisions queries on the seed', () => {
  let db: Db;
  const FACTORY = ['mission-control'];

  beforeAll(async () => {
    db = await onTheSeed();
  }, 60_000);
  afterAll(() => db.close());

  /** What the screen shows, and what the tab counts. */
  const shown = async () =>
    (await db.query(ATTENTION, FACTORY)).length + (await db.query(OWNER, FACTORY)).length;
  const counted = async () => (await db.query(COUNT, FACTORY)).length;

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

  test('the tab counts exactly the items the screen shows', async () => {
    expect(await shown()).toBe(5);
    expect(await counted()).toBe(5);
  });

  test('it still does after another needs-owner issue and another attention run', async () => {
    await db.transaction(async (tx) => {
      await writeRow(tx, 'label', new Date('2026-10-25T12:00:00Z'));
      await tx.query(
        `INSERT INTO public.remote_agent_workflow_runs
           (workflow_name, codebase_id, status, user_message, metadata)
         SELECT 'archon-intake', codebase_id, 'paused', 'x', $1::jsonb
         FROM public.remote_agent_workflow_runs WHERE status = 'paused' LIMIT 1`,
        [
          JSON.stringify({
            wait: {
              kind: 'attention',
              nodeId: 'ask',
              waitingSince: '2026-10-25T12:00:00Z',
              message: 'Which?',
            },
          }),
        ],
      );
    });
    expect(await shown()).toBe(7);
    expect(await counted()).toBe(7);
  });
});
