import { afterAll, beforeAll, expect, test } from 'bun:test';
import { eventData } from '../scripts/fixture/write';
import { migratedDb } from './queries/test-seed';
import { STOP_CORPUS } from './run-stops-corpus';
import type { TestDb } from './test-db';

let db: TestDb;
beforeAll(async () => {
  db = await migratedDb();
});
afterAll(async () => {
  await db.close();
});

test('mc.stop_class puts a corpus of real error lines in the expected classes', async () => {
  expect(STOP_CORPUS.length).toBeGreaterThanOrEqual(25);
  const got = [];
  for (const [line, , source] of STOP_CORPUS) {
    const [row] = await db.query('SELECT mc.stop_class($1) AS class', [line]);
    got.push([line, row?.class, source]);
  }
  expect(got).toEqual(STOP_CORPUS.map(([line, cls, source]) => [line, cls, source]));
});

test('mc.stop_signature ignores ids, numbers, paths and shas, and keeps steps and workflows apart', async () => {
  const sig = async (workflow: string, step: string, line: string) =>
    (
      (await db.query('SELECT mc.stop_signature($1, $2, $3) AS s', [workflow, step, line]))[0] as {
        s: string;
      }
    ).s;
  const a = await sig(
    'archon-build-queue',
    'check',
    String.raw`check must write C:\w\run-1\app-check\result.json, round 2 of 3 at 4f2a9c1d0b7e for 7c2f1e87-4010-4c2a-9ac4-f00000000000`,
  );
  const b = await sig(
    'archon-build-queue',
    'check',
    String.raw`check must write D:\x\run-9\app-check\result.json, round 7 of 9 at 0a1b2c3d4e5f for 11111111-2222-4333-8444-555555555555`,
  );
  expect(a).toBe(b);
  expect(await sig('archon-build-queue', 'evidence', 'check must write x')).not.toBe(
    await sig('archon-build-queue', 'check', 'check must write x'),
  );
  expect(await sig('archon-loop', 'check', 'x')).not.toBe(
    await sig('archon-build-queue', 'check', 'x'),
  );
  expect(await sig('w', 's', 'GET https://api.github.com/x failed')).toContain('https:');
});

const NOW = new Date('2026-10-25T12:00:00Z');
const stopOf = async (id: string) =>
  (
    await db.query(
      'SELECT step_id, line, class, status, signature FROM mc.run_stops WHERE run_id = $1',
      [id],
    )
  )[0];
const newRun = async (workflow = 'archon-build-queue', status = 'running', metadata: object = {}) =>
  String(
    (
      await db.query(
        `INSERT INTO public.remote_agent_workflow_runs (workflow_name, status, user_message, metadata)
         VALUES ($1, $2, 'q', $3) RETURNING id`,
        [workflow, status, JSON.stringify(metadata)],
      )
    )[0]?.id,
  );
const setStatus = (id: string, status: string) =>
  db.query(
    `UPDATE public.remote_agent_workflow_runs SET status = $2::text,
       completed_at = CASE WHEN $2 IN ('running', 'paused') THEN NULL ELSE now() END WHERE id = $1`,
    [id, status],
  );
const failStep = (id: string, step: string, error: string) =>
  db.query(
    `INSERT INTO public.remote_agent_workflow_events (workflow_run_id, event_type, step_name, data)
     VALUES ($1, 'node_failed', $2, $3)`,
    [id, step, JSON.stringify(eventData(step, 'node_failed', NOW, error))],
  );

test('a run stop record follows Archon’s writes, so a fixed run never shows as failing', async () => {
  const id = await newRun();
  await failStep(id, 'pr__publish', '\n  gh: HTTP 502: Bad Gateway\nsecond line');
  await setStatus(id, 'failed');
  expect(await stopOf(id)).toMatchObject({
    status: 'failed',
    step_id: 'pr__publish',
    line: 'gh: HTTP 502: Bad Gateway',
    class: 'transient',
  });

  await setStatus(id, 'running');
  expect(await stopOf(id)).toBeUndefined();

  const early = await newRun();
  await setStatus(early, 'failed');
  expect(await stopOf(early)).toMatchObject({ step_id: null, class: null });
  await failStep(early, 'check', 'No issue matched the query');
  expect(await stopOf(early)).toMatchObject({ step_id: 'check', class: 'input' });

  const done = await newRun('archon-loop');
  await setStatus(done, 'completed');
  expect(await stopOf(done)).toMatchObject({ status: 'completed', step_id: null, class: null });
});

test('a paused run’s stop record is the question it asks', async () => {
  const id = await newRun('archon-build-queue', 'paused', {
    wait: {
      nodeId: 'ask',
      kind: 'attention',
      waitingSince: '2026-10-24T10:20:00.000Z',
      message: '**Scope decision**\n\nShip it?',
      pauseId: 'p1',
      form: 'select',
      options: [{ id: 'ship', label: 'Ship' }],
    },
  });
  expect(await stopOf(id)).toMatchObject({
    status: 'paused',
    step_id: 'ask',
    line: '**Scope decision**',
    class: null,
  });
});

test('a run stop record that cannot be written never fails Archon’s write', async () => {
  const id = await newRun();
  const rolledBack = db.transaction(async (tx) => {
    await tx.query('ALTER TABLE mc.run_stops RENAME TO run_stops_gone');
    await tx.query(`UPDATE public.remote_agent_workflow_runs SET status = 'failed' WHERE id = $1`, [
      id,
    ]);
    expect(await tx.query('SELECT status FROM mc.laps WHERE run_id = $1', [id])).toEqual([
      { status: 'failed' },
    ]);
    const errors = await tx.query('SELECT source FROM mc.projection_errors WHERE run_id = $1', [
      id,
    ]);
    expect(errors.some((e) => String(e.source).startsWith('run_stops_'))).toBe(true);
    throw new Error('rollback');
  });
  await expect(rolledBack).rejects.toThrow('rollback');
});
