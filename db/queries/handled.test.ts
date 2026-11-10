import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Db } from '../../scripts/lib/db';
import { onTheSeed, queries } from './test-seed';

const HANDLED = queries.find(([n]) => n === 'handled')?.[1] as string;
const RESUMED = '5eed0000-0000-4000-8000-0000000000a1';

describe('the handled query', () => {
  let db: Db;

  beforeAll(async () => {
    db = await onTheSeed();
  }, 60_000);
  afterAll(() => db.close());

  const send = (factory: string, option: string, undone: boolean, at: string) =>
    db.query(
      `INSERT INTO mc.actions (factory, who, action, run_id, occurrence, option, recorded_at, undone, sent_at)
       VALUES ($1, 'cole', 'answer', $2, 'occ', $3, $4, $5, CASE WHEN $5 THEN NULL ELSE $4::timestamptz END)`,
      [factory, RESUMED, option, at, undone],
    );

  test('lists what was sent for the factory, newest first, with the run workflow', async () => {
    await db.query(
      `INSERT INTO mc.laps (run_id, factory, workflow_name, status, started_at)
       VALUES ($1, 'mission-control', 'archon-loop', 'completed', '2026-10-10T08:00:00Z')
       ON CONFLICT DO NOTHING`,
      [RESUMED],
    );
    await send('mission-control', 'sent-later', false, '2026-10-10T09:00:00Z');
    await send('mission-control', 'taken-back', true, '2026-10-10T10:00:00Z');
    await send('other-factory', 'not-ours', false, '2026-10-10T11:00:00Z');
    const rows = await db.query(HANDLED, ['mission-control']);
    expect(rows.map((r) => r.option)).toEqual(['sent-later', null]);
    expect(rows[1]).toMatchObject({ action: 'resume', run_id: RESUMED, from_step: 'implement' });
    expect(rows[1].workflow_name).toBe('archon-loop');
  });
});
