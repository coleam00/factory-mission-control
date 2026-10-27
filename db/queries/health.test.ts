import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  CAUSES,
  countByCause,
  failedLaps,
  type HealthRunRow,
  type HealthStepRow,
  type HealthWorkableRow,
  overdueSteps,
  waitingRuns,
  workable,
} from '../../app/lib/health';
import { eventData } from '../../scripts/fixture/write';
import type { Db } from '../../scripts/lib/db';
import { onTheSeed, queries } from './test-seed';

const HEALTH = ['health-runs', 'health-steps', 'health-workable'];
const sqlOf = (name: string) => queries.find(([n]) => n === name)?.[1] as string;

test.each(HEALTH)('%s is a single SELECT with no volatile function', (name) => {
  const sql = sqlOf(name);
  expect(sql).toMatch(/^SELECT\b/);
  expect(sql).not.toContain(';');
  for (const banned of ['now(', 'random(', 'clock_timestamp(', 'current_timestamp']) {
    expect(sql.toLowerCase()).not.toContain(banned);
  }
});

const FACTORY = 'mission-control';
/** Lap A: running since 2026-10-21, on build. */
const LAP_A = '5eed0003-0000-4000-8000-00000000000a';
/** Lap B: running since 2026-10-24, on check-app. */
const LAP_B = '5eed0003-0000-4000-8000-00000000000b';
/** A moment after the seed's: both running steps have run for days. */
const NOW = Date.parse('2026-10-27T12:00:00Z');

describe('the health queries on the seed', () => {
  let db: Db;
  const rows = async <Row>(name: string, factory = FACTORY) =>
    (await db.query(sqlOf(name), [factory])) as unknown as Row[];

  beforeAll(async () => {
    db = await onTheSeed();
  }, 60_000);

  afterAll(() => db.close());

  test('one run is pending and one paused', async () => {
    const waiting = waitingRuns(await rows<HealthRunRow>('health-runs'));
    expect(waiting.map((run) => run.status)).toEqual(['pending', 'paused']);
  });

  test('the six failed laps split across all four causes', async () => {
    const laps = failedLaps(await rows<HealthRunRow>('health-runs'));
    expect(laps).toHaveLength(6);
    expect(laps.every((lap) => lap.failed_step === 'build')).toBe(true);
    expect(countByCause(laps)).toEqual({
      'usage-limit': 2,
      authentication: 2,
      infrastructure: 1,
      other: 1,
    });
  });

  test("both running laps' steps have run past twice their p90", async () => {
    const steps = await rows<HealthStepRow>('health-steps');
    const overdue = overdueSteps(steps, NOW);
    expect(overdue.map((step) => [step.run_id, step.step_id])).toEqual([
      [LAP_A, 'build'],
      [LAP_B, 'check-app'],
    ]);
    expect(overdue.map((step) => step.p90_ms)).toEqual([20 * 60_000, 20 * 60_000]);
    // The second factory's running lap is on claim, which has no completion there.
    const other = await rows<HealthStepRow>('health-steps', 'second-factory');
    expect(other.map((row) => row.kind)).toEqual(['running']);
    expect(overdueSteps(other, NOW)).toEqual([]);
  });

  test('a step has at most 50 completions, its latest', async () => {
    const steps = await rows<HealthStepRow>('health-steps');
    const builds = steps.filter((row) => row.kind === 'completion' && row.step_id === 'build');
    expect(builds.length).toBeGreaterThan(0);
    await db.query(
      `INSERT INTO mc.laps (run_id, factory, workflow_name, status)
       SELECT ('00000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, $1, 'archon-loop',
         'completed' FROM (VALUES (0)) v, LATERAL generate_series(1, 60) n`,
      [FACTORY],
    );
    await db.query(
      `INSERT INTO mc.lap_steps (run_id, step_id, status, started_at, completed_at, duration_ms)
       SELECT ('00000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, 'build', 'completed',
         '2026-10-26T00:00:00Z'::timestamptz + n * interval '1 minute',
         '2026-10-26T00:00:00Z'::timestamptz + n * interval '1 minute' + interval '1 second', 1000
       FROM generate_series(1, 60) n`,
    );
    const latest = (await rows<HealthStepRow>('health-steps')).filter(
      (row) => row.kind === 'completion' && row.step_id === 'build',
    );
    expect(latest).toHaveLength(50);
    expect(latest.every((row) => Number(row.duration_ms) === 1000)).toBe(true);
    await db.query(`DELETE FROM mc.laps WHERE run_id::text LIKE '00000000-0000-4000-8000-%'`);
    await db.query(`DELETE FROM mc.lap_steps WHERE run_id::text LIKE '00000000-0000-4000-8000-%'`);
  });

  test('three issues are workable against two running laps', async () => {
    const shown = workable(await rows<HealthWorkableRow>('health-workable'));
    expect(shown.issues.map((issue) => issue.issue_number)).toEqual([9, 17, 18]);
    expect(shown.running).toBe(2);
  });

  test('a released claim, a closed dependency and a needs-owner label each move an issue', async () => {
    const workableNumbers = async () =>
      workable(await rows<HealthWorkableRow>('health-workable')).issues.map((i) => i.issue_number);
    await db.query(
      `UPDATE mc.claims SET released_at = '2026-10-26T00:00:00Z'
       WHERE factory = $1 AND issue_number = 16`,
      [FACTORY],
    );
    await db.query(`UPDATE mc.issues SET state = 'closed' WHERE factory = $1 AND number = 13`, [
      FACTORY,
    ]);
    await db.query(
      `INSERT INTO mc.issue_labels (factory, issue_number, label) VALUES ($1, 18, 'needs-owner')`,
      [FACTORY],
    );
    expect(await workableNumbers()).toEqual([9, 14, 16, 17]);
  });

  test('a failed step on a running lap counts it as failed by its error, as fixture:write writes it', async () => {
    const before = countByCause(failedLaps(await rows<HealthRunRow>('health-runs')));
    await db.query(
      `INSERT INTO remote_agent_workflow_events (workflow_run_id, event_type, step_name, data)
       VALUES ($1, 'node_failed', 'deploy', $2::jsonb)`,
      [LAP_B, eventData('deploy', 'node_failed', new Date(NOW), 'ECONNRESET')],
    );
    const after = countByCause(failedLaps(await rows<HealthRunRow>('health-runs')));
    expect(after).toEqual({ ...before, infrastructure: before.infrastructure + 1 });
    expect(Object.keys(after)).toEqual([...CAUSES]);
  });

  test('another factory sees none of these rows but its own running lap', async () => {
    expect(await rows('health-runs', 'second-factory')).toEqual([]);
    expect(
      (await rows<HealthWorkableRow>('health-workable', 'second-factory')).map((r) => r.kind),
    ).toEqual(['lap']);
  });
});
