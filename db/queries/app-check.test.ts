import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { AppCheckRow } from '../../app/lib/app-check';
import type { Db } from '../../scripts/lib/db';
import { onTheSeed, queries } from './test-seed';

const sql = queries.find(([name]) => name === 'app-check')?.[1] as string;
let db: Db;
beforeAll(async () => {
  db = await onTheSeed();
}, 60_000);
afterAll(() => db.close());

const rows = async () => (await db.query(sql, ['mission-control'])) as unknown as AppCheckRow[];
const verdict = async (pr: number) => (await rows()).find((r) => r.number === pr);

test('the latest check of an open pull request is listed with its verdict, and not a skipped one or a merged pull request', async () => {
  const run = (n: number) => `00000000-0000-4000-8000-0000000000c${n}`;
  await db.query('BEGIN');
  try {
    const [open] = await db.query(
      `SELECT number FROM mc.pull_requests WHERE factory = 'mission-control' AND state = 'open' LIMIT 1`,
    );
    const [closed] = await db.query(
      `SELECT number FROM mc.pull_requests WHERE factory = 'mission-control' AND state <> 'open' LIMIT 1`,
    );
    const pr = Number(open?.number);
    const lap = (n: number, started: string) =>
      db.query(
        `INSERT INTO mc.laps (run_id, factory, workflow_name, status, started_at)
         VALUES ($1, 'mission-control', 'factory-app-check', 'completed', $2)`,
        [run(n), started],
      );
    const step = (n: number, id: string, status: string, started: string, output: unknown) =>
      db.query(
        `INSERT INTO mc.lap_steps (run_id, step_id, status, started_at, output)
         VALUES ($1, $2, $3, $4, $5)`,
        [run(n), id, status, started, output === null ? null : JSON.stringify(output)],
      );

    await lap(1, '2030-01-01T00:00:00Z');
    await step(1, 'check', 'completed', '2030-01-01T00:00:00Z', { pr, overall: 'FAIL' });
    expect(await verdict(pr)).toMatchObject({ run_id: run(1), overall: 'FAIL' });

    // A newer run of the queue's check finds the pull request through its `select` step.
    await lap(2, '2030-01-02T00:00:00Z');
    await step(2, 'select', 'completed', '2030-01-02T00:00:00Z', { pr });
    await step(2, 'check', 'running', '2030-01-02T00:00:00Z', null);
    expect(await verdict(pr)).toMatchObject({ run_id: run(2), overall: null });

    // A newer run that skipped its check, or whose check failed, does not hide the verdict.
    await lap(3, '2030-01-03T00:00:00Z');
    await step(3, 'select', 'completed', '2030-01-03T00:00:00Z', { pr });
    await step(3, 'check', 'skipped', '2030-01-03T00:00:00Z', null);
    await lap(4, '2030-01-04T00:00:00Z');
    await step(4, 'select', 'completed', '2030-01-04T00:00:00Z', { pr });
    await step(4, 'check', 'failed', '2030-01-04T00:00:00Z', null);
    expect(await verdict(pr)).toMatchObject({ run_id: run(2), overall: null });

    await lap(5, '2030-01-05T00:00:00Z');
    await step(5, 'check', 'completed', '2030-01-05T00:00:00Z', {
      pr: Number(closed?.number),
      overall: 'PASS',
    });
    expect(await verdict(Number(closed?.number))).toBeUndefined();
  } finally {
    await db.query('ROLLBACK');
  }
});

test("a pull request lists the lines of its latest check by kind, and not another run's", async () => {
  const run = (n: number) => `00000000-0000-4000-8000-0000000000d${n}`;
  await db.query('BEGIN');
  try {
    const [open] = await db.query(
      `SELECT number FROM mc.pull_requests WHERE factory = 'mission-control' AND state = 'open' LIMIT 1`,
    );
    const pr = Number(open?.number);
    for (const n of [1, 2]) {
      await db.query(
        `INSERT INTO mc.laps (run_id, factory, workflow_name, status, started_at)
         VALUES ($1, 'mission-control', 'factory-app-check', 'completed', $2)`,
        [run(n), `2031-01-0${n}T00:00:00Z`],
      );
    }
    await db.query(
      `INSERT INTO mc.lap_steps (run_id, step_id, status, started_at, output)
       VALUES ($1, 'check', 'completed', '2031-01-01T00:00:00Z', $2)`,
      [run(1), JSON.stringify({ pr, overall: 'PASS' })],
    );
    const line = (id: string, position: number, kind: string) =>
      db.query(
        `INSERT INTO mc.app_check_lines (run_id, position, kind, verdict, evidence_count)
         VALUES ($1, $2, $3, 'PASS', 1)`,
        [id, position, kind],
      );
    const kinds = ['criterion', 'criterion', 'probe', 'assertion', 'assertion', 'assertion'];
    for (const [position, kind] of kinds.entries()) await line(run(1), position, kind);
    await line(run(2), 0, 'criterion');

    expect(await verdict(pr)).toMatchObject({
      run_id: run(1),
      criteria: 2,
      probes: 1,
      assertions: 3,
    });
  } finally {
    await db.query('ROLLBACK');
  }
});
