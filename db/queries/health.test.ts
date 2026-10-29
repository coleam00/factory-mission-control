import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  CAUSES,
  COMPLETIONS,
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

  test('a step has at most COMPLETIONS completions, its latest', async () => {
    const steps = await rows<HealthStepRow>('health-steps');
    const builds = steps.filter((row) => row.kind === 'completion' && row.step_id === 'build');
    expect(builds.length).toBeGreaterThan(0);
    await db.query(
      `INSERT INTO mc.laps (run_id, factory, workflow_name, status)
       SELECT ('00000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, $1, 'archon-loop',
         'completed' FROM generate_series(1, $2::int) n`,
      [FACTORY, COMPLETIONS + 10],
    );
    await db.query(
      `INSERT INTO mc.lap_steps (run_id, step_id, status, started_at, completed_at, duration_ms)
       SELECT ('00000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, 'build', 'completed',
         '2026-10-26T00:00:00Z'::timestamptz + n * interval '1 minute',
         '2026-10-26T00:00:00Z'::timestamptz + n * interval '1 minute' + interval '1 second', 1000
       FROM generate_series(1, $1::int) n`,
      [COMPLETIONS + 10],
    );
    const latest = (await rows<HealthStepRow>('health-steps')).filter(
      (row) => row.kind === 'completion' && row.step_id === 'build',
    );
    expect(latest).toHaveLength(COMPLETIONS);
    expect(latest.every((row) => Number(row.duration_ms) === 1000)).toBe(true);
    await db.query(`DELETE FROM mc.laps WHERE run_id::text LIKE '00000000-0000-4000-8000-%'`);
    await db.query(`DELETE FROM mc.lap_steps WHERE run_id::text LIKE '00000000-0000-4000-8000-%'`);
  });

  test('one issue is workable against two running laps', async () => {
    const shown = workable(await rows<HealthWorkableRow>('health-workable'));
    expect(shown.issues.map((issue) => issue.issue_number)).toEqual([9]);
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
    expect(await workableNumbers()).toEqual([9, 14, 16]);
  });

  test("the manager's tracking issues are never workable; a title only containing one is", async () => {
    const workableNumbers = async () =>
      workable(await rows<HealthWorkableRow>('health-workable')).issues.map((i) => i.issue_number);
    const seeded = await db.query(
      `SELECT number, title FROM mc.issues WHERE factory = $1 AND number IN (17, 18) ORDER BY number`,
      [FACTORY],
    );
    expect(seeded).toEqual([
      { number: 17, title: 'Owner decisions needed' },
      { number: 18, title: 'Loop metrics' },
    ]);
    await db.query(`DELETE FROM mc.issue_labels WHERE factory = $1 AND issue_number = 18`, [
      FACTORY,
    ]);
    const before = await workableNumbers();
    expect(before).not.toContain(17);
    expect(before).not.toContain(18);
    await db.query(
      `INSERT INTO mc.issues (factory, number, title, state, url, created_at, updated_at) VALUES
         ($1, 9001, 'Show Owner decisions needed on the home map', 'open',
           'https://example.test/9001', '2026-10-26T00:00:00Z', '2026-10-26T00:00:00Z'),
         ($1, 9002, 'Loop metrics chart', 'open',
           'https://example.test/9002', '2026-10-26T00:00:00Z', '2026-10-26T00:00:00Z')`,
      [FACTORY],
    );
    expect(await workableNumbers()).toEqual([...before, 9001, 9002]);
    await db.query(`DELETE FROM mc.issues WHERE factory = $1 AND number IN (9001, 9002)`, [
      FACTORY,
    ]);
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
