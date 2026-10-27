import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { OUTCOMES } from '../../app/lib/laps';
import { type ScorecardRow, versionLaps } from '../../app/lib/scorecard';
import { SEED_CODEBASE } from '../../scripts/fixture/seed';
import { seedLaps } from '../../scripts/fixture/seed-laps';
import { eventData } from '../../scripts/fixture/write';
import type { Db } from '../../scripts/lib/db';
import { onTheSeed, queries, SEED } from './test-seed';

describe('lanes and recent-laps on the seed', () => {
  let db: Db;
  const sqlOf = (name: string) => queries.find(([n]) => n === name)?.[1] as string;
  const laps = seedLaps(SEED);
  const finished = laps.filter((l) => !['running', 'paused', 'pending'].includes(l.what));

  beforeAll(async () => {
    db = await onTheSeed();
  }, 60_000);

  afterAll(() => db.close());

  test('lanes are exactly the two running seed laps, each with its claim, pick and cost', async () => {
    const lanes = await db.query(sqlOf('lanes'), ['mission-control']);
    const running = laps.filter((l) => l.what === 'running');
    expect(running).toHaveLength(2);
    expect(lanes.map((l) => [l.run_id, l.issue_number]).sort()).toEqual(
      running.map((l) => [l.runId, l.issue]).sort(),
    );
    for (const lane of lanes) {
      expect([lane.route, lane.depth]).toEqual(['simple', 'normal']);
      const [step] = await db.query(
        `SELECT step_id, started_at FROM mc.lap_steps WHERE run_id = $1 AND status = 'running'`,
        [lane.run_id],
      );
      expect([lane.step_id, lane.step_started_at]).toEqual([step.step_id, step.started_at]);
      const [cost] = await db.query(
        'SELECT sum(cost_usd)::float8 AS c FROM mc.lap_step_attempts WHERE run_id = $1',
        [lane.run_id],
      );
      expect(lane.cost_usd).toBe(cost.c);
      expect(lane.cost_usd).toBeGreaterThan(0);
    }
  });

  test("recent laps are every finished seed lap with the seed's outcome, all six present", async () => {
    const recent = await db.query(sqlOf('recent-laps'), ['mission-control']);
    expect(Object.fromEntries(recent.map((l) => [l.run_id, l.outcome]))).toEqual(
      Object.fromEntries(finished.map((l) => [l.runId, l.what])),
    );
    expect(new Set(recent.map((l) => l.outcome))).toEqual(new Set(OUTCOMES));
  });

  test("a finished lap's cost in recent laps is the cost the scorecard counts for it", async () => {
    const recent = await db.query(sqlOf('recent-laps'), ['mission-control']);
    const rows = (await db.query(sqlOf('scorecard'), [
      'mission-control',
    ])) as unknown as ScorecardRow[];
    const digests = new Set(rows.flatMap((r) => ('digest' in r && r.digest ? [r.digest] : [])));
    const card = new Map(
      [...digests].flatMap((d) => versionLaps(rows, d)).map((lap) => [lap.id, lap.cost]),
    );
    const costed = recent.filter((l) => card.has(String(l.run_id)));
    expect(costed.length).toBe(finished.length);
    for (const lap of costed) {
      expect(lap.cost_usd ?? 0).toBeCloseTo(card.get(String(lap.run_id)) ?? Number.NaN, 9);
    }
  });

  test('a lap whose review ran twice counts both runs in its lane and in recent laps (#116)', async () => {
    const digest = 'sha256:repeated-review-116';
    const rollback = new Error('rollback');
    await db
      .transaction(async (tx) => {
        const [run] = await tx.query(
          `INSERT INTO remote_agent_workflow_runs (workflow_name, codebase_id, status, user_message,
           metadata, started_at)
         VALUES ('archon-loop', $1, 'running', 'Run the loop', $2, '2026-10-25T10:00:00Z')
         RETURNING id`,
          [SEED_CODEBASE, JSON.stringify({ workflow_source: { digest } })],
        );
        const runId = String(run?.id);
        const event = (type: string, step: string, at: string, data: object) =>
          tx.query(
            `INSERT INTO remote_agent_workflow_events (workflow_run_id, event_type, step_name, data,
             created_at) VALUES ($1, $2, $3, $4, $5)`,
            [runId, type, step, JSON.stringify({ timing: { startedAt: at }, ...data }), at],
          );
        const costOf = async (query: string) =>
          (await tx.query(sqlOf(query), ['mission-control'])).find((l) => l.run_id === runId)
            ?.cost_usd;
        await event('node_completed', 'pick', '2026-10-25T10:05:00Z', {
          cost_usd: 0.5,
          structured_output: { route: 'simple' },
        });
        await event('node_completed', 'review', '2026-10-25T10:20:00Z', {
          cost_usd: 0.75,
          structured_output: { outcome: 'sent-back' },
        });
        // The review runs again: its step row restarts with no cost, its first run still counts.
        await event('node_started', 'review', '2026-10-25T10:30:00Z', {});
        expect(await costOf('lanes')).toBeCloseTo(1.25, 9);
        await event('node_completed', 'review', '2026-10-25T10:45:00Z', {
          cost_usd: 1,
          structured_output: { outcome: 'merge' },
        });
        await event('node_completed', 'land', '2026-10-25T10:50:00Z', {
          cost_usd: 0.25,
          structured_output: { outcome: 'merged' },
        });
        expect(await costOf('lanes')).toBeCloseTo(2.5, 9);
        await tx.query(
          `UPDATE remote_agent_workflow_runs SET status = 'completed',
           completed_at = '2026-10-25T11:00:00Z' WHERE id = $1`,
          [runId],
        );
        const [steps] = await tx.query(
          'SELECT sum(cost_usd)::float8 AS c FROM mc.lap_steps WHERE run_id = $1',
          [runId],
        );
        // The step rows hold only each step's latest run; recent laps must not read them alone.
        expect(steps?.c).toBeCloseTo(1.75, 9);
        expect(await costOf('recent-laps')).toBeCloseTo(2.5, 9);
        const rows = (await tx.query(sqlOf('scorecard'), [
          'mission-control',
        ])) as unknown as ScorecardRow[];
        expect(versionLaps(rows, digest).map((lap) => lap.cost)).toEqual([2.5]);
        throw rollback;
      })
      .catch((error) => {
        if (error !== rollback) throw error;
      });
  });

  test('a review node_started from fixture:write moves its lane to review', async () => {
    const errors = () => db.query('SELECT id FROM mc.projection_errors ORDER BY id');
    const before = await errors();
    const [lane] = await db.query(sqlOf('lanes'), ['mission-control']);
    await db.query(
      `INSERT INTO remote_agent_workflow_events (workflow_run_id, event_type, step_name, data)
       VALUES ($1, 'node_started', 'review', $2::jsonb)`,
      [lane.run_id, eventData('review', 'node_started', new Date('2026-10-25T12:00:00Z'))],
    );
    const moved = await db.query(sqlOf('lanes'), ['mission-control']);
    expect(moved.find((l) => l.run_id === lane.run_id)?.step_id).toBe('review');
    expect(await errors()).toEqual(before);
  });

  test("a lane's route falls back to its claim comment; the pick step's output wins (#107)", async () => {
    const [claimOnly, both, neither] = [
      '107a0000-0000-4000-8000-000000000001',
      '107a0000-0000-4000-8000-000000000002',
      '107a0000-0000-4000-8000-000000000003',
    ];
    const routes = async () =>
      Object.fromEntries(
        (await db.query(sqlOf('lanes'), ['route-107'])).map((l) => [l.run_id, l.route]),
      );
    await db.query(
      `INSERT INTO mc.laps (run_id, factory, workflow_name, status) VALUES
      ($1, 'route-107', 'archon-loop', 'running'), ($2, 'route-107', 'archon-loop', 'running'),
      ($3, 'route-107', 'archon-loop', 'running')`,
      [claimOnly, both, neither],
    );
    await db.query(
      `INSERT INTO mc.lap_steps (run_id, step_id, status, output)
       VALUES ($1, 'pick', 'completed', '{"route":"continue"}'::jsonb)`,
      [both],
    );
    expect(await routes()).toEqual({ [claimOnly]: null, [both]: 'continue', [neither]: null });
    await db.query(
      `INSERT INTO mc.claims (factory, issue_number, run_id, route, claimed_at) VALUES
       ('route-107', 7, $1, 'simple', '2026-10-26T12:00:00Z'),
       ('route-107', 8, $2, 'simple', '2026-10-26T12:00:00Z')`,
      [claimOnly, both],
    );
    expect(await routes()).toEqual({
      [claimOnly]: 'simple',
      [both]: 'continue',
      [neither]: null,
    });
  });

  test('another factory sees none of these laps', async () => {
    expect(await db.query(sqlOf('lanes'), ['other'])).toEqual([]);
    expect(await db.query(sqlOf('recent-laps'), ['other'])).toEqual([]);
  });
});
