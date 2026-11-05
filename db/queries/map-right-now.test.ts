import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { MapRightNowRow } from '../../app/map/live';
import { QUEUE_RUNS } from '../../scripts/fixture/seed';
import type { Db } from '../../scripts/lib/db';
import { onTheSeed, queries } from './test-seed';

const sql = queries.find(([name]) => name === 'map-right-now')?.[1] as string;

let db: Db;
beforeAll(async () => {
  db = await onTheSeed();
}, 60_000);
afterAll(() => db.close());

const rows = async (factory: string) =>
  (await db.query(sql, [factory])) as unknown as MapRightNowRow[];

/** A step finishing, written to Archon's event table so the real projection runs. */
const completed = (run: string, step: string, output: object, at: string) =>
  db.query(
    `INSERT INTO remote_agent_workflow_events (workflow_run_id, event_type, step_name, data, created_at)
     VALUES ($1, 'node_completed', $2, $3::jsonb, $4)`,
    [
      run,
      step,
      JSON.stringify({
        timing: { startedAt: at, durationMs: 1000 },
        duration_ms: 1000,
        structured_output: output,
      }),
      at,
    ],
  );

const deployRun = async (id: string, startedAt: string) => {
  await db.query(
    `INSERT INTO remote_agent_workflow_runs (id, workflow_name, codebase_id, status, user_message, metadata, started_at, completed_at)
     SELECT $1, 'factory-deploy', codebase_id, 'completed', 'deploy', '{}', $2::timestamptz, $2::timestamptz + interval '5 minutes'
     FROM remote_agent_workflow_runs WHERE id = $3`,
    [id, startedAt, QUEUE_RUNS.merged],
  );
};

test('the gate lists a run once it swept and recorded, for its own factory only', async () => {
  expect((await rows('queue-factory')).filter((r) => r.kind === 'outcomes')).toEqual([]);
  const decisions = [
    { number: 404, action: 'merged', reason: 'Ready at head, all green' },
    { number: 407, action: 'return', reason: 'conflicts with main' },
  ];
  await completed(QUEUE_RUNS.merged, 'sweep', { decisions }, '2026-10-24T09:07:00Z');
  const gate = (await rows('queue-factory')).filter((r) => r.kind === 'outcomes');
  expect(gate).toHaveLength(1);
  expect(JSON.parse(gate[0]?.decisions ?? 'null')).toEqual(decisions);
  expect(JSON.parse(gate[0]?.merged ?? 'null')).toEqual([404, 405]);
  expect(await rows('mission-control')).toEqual([]);
});

test('the latest deploy is the newest finished run, whether or not it verified', async () => {
  const good = '5eed0009-0000-4000-8000-000000000001';
  const bad = '5eed0009-0000-4000-8000-000000000002';
  const rev = 'a'.repeat(40);
  await deployRun(good, '2026-10-25T09:00:00Z');
  await completed(good, 'preflight', { revision: rev }, '2026-10-25T09:01:00Z');
  await completed(
    good,
    'deploy',
    { deployed_revision: rev, health_status: 'healthy' },
    '2026-10-25T09:02:00Z',
  );
  await completed(good, 'verify', { deployed: true }, '2026-10-25T09:03:00Z');
  const first = (await rows('queue-factory')).filter((r) => r.kind === 'deploys');
  expect(first).toHaveLength(1);
  expect(first[0]).toMatchObject({
    run_id: good,
    status: 'verified',
    revision: rev,
    health: 'healthy',
  });

  await deployRun(bad, '2026-10-26T09:00:00Z');
  await completed(
    bad,
    'deploy',
    { deployed_revision: 'b'.repeat(40), health_status: 'unhealthy' },
    '2026-10-26T09:02:00Z',
  );
  const second = (await rows('queue-factory')).filter((r) => r.kind === 'deploys');
  expect(second).toHaveLength(1);
  expect(second[0]).toMatchObject({ run_id: bad, status: 'failed', health: 'unhealthy' });
});

test('an old-loop lap whose deploy did not read back is a failed deploy', async () => {
  const lap = (
    (await db.query(
      `SELECT run_id FROM mc.laps WHERE factory = 'mission-control' AND workflow_name = 'archon-loop' LIMIT 1`,
    )) as { run_id: string }[]
  )[0]?.run_id as string;
  await completed(lap, 'deploy__health', { ok: false }, '2026-10-27T09:00:00Z');
  await completed(
    lap,
    'deploy__verify',
    { deployed: false, revision: 'c'.repeat(40) },
    '2026-10-27T09:01:00Z',
  );
  const deploys = (await rows('mission-control')).filter((r) => r.kind === 'deploys');
  expect(deploys).toHaveLength(1);
  expect(deploys[0]).toMatchObject({ status: 'failed', health: 'unhealthy' });
});
