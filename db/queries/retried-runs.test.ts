import { expect, test } from 'bun:test';
import { retriedArgs } from '../../app/lib/failure-view';
import { pinZone } from '../../app/lib/pin-zone';
import { migratedDb, queries } from './test-seed';

pinZone('America/Chicago');

test('a run from yesterday, local time, is not a retried run of today', async () => {
  const db = await migratedDb();
  try {
    await db.query(
      `INSERT INTO mc.factories (name, repository, codebase, console) VALUES ('f', 'o/r', 'o/r', 'c')`,
    );
    let n = 0;
    const lap = async (status: string, at: string, error?: string) => {
      const id = `5eed0000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
      await db.query(
        `INSERT INTO mc.laps (run_id, factory, workflow_name, status, started_at, completed_at)
         VALUES ($1, 'f', 'ticks', $2, $3::timestamptz, $3::timestamptz)`,
        [id, status, at],
      );
      if (error !== undefined) {
        await db.query(
          `INSERT INTO mc.lap_steps (run_id, step_id, status, completed_at, error)
           VALUES ($1, 'facts', 'failed', $2::timestamptz, $3)`,
          [id, at, error],
        );
      }
      return id;
    };
    const blip = "Couldn't connect to compute node";
    // 06:23 and 23:59 on 11/11 local, then 00:01 on 11/12 local; the factory's latest UTC stop day is 11/12.
    await lap('failed', '2026-11-11T12:23:00Z', blip);
    await lap('completed', '2026-11-11T12:40:00Z');
    await lap('failed', '2026-11-12T05:59:00Z', blip);
    const today = await lap('failed', '2026-11-12T06:01:00Z', blip);
    await lap('completed', '2026-11-12T06:30:00Z');

    const sql = queries.find(([name]) => name === 'retried-runs')?.[1] as string;
    const now = new Date('2026-11-12T15:00:00Z');
    const rows = await db.query(sql, ['f', ...retriedArgs(now)]);
    expect(rows.map((r) => r.run_id)).toEqual([today]);
  } finally {
    await db.close();
  }
}, 60_000);
