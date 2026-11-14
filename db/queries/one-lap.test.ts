import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  attemptsInOrder,
  type OneLapRow,
  type StepAttemptRow,
  shownDispositions,
} from '../../app/lib/one-lap';
import { managerRead, runCost, runTimeline, stepCost } from '../../app/lib/one-run';
import {
  QUEUE_PAGE_RUNS,
  QUEUE_RETURNED,
  QUEUE_RUNS,
  QUEUE_UNSTICK,
} from '../../scripts/fixture/seed';
import { seedLaps } from '../../scripts/fixture/seed-laps';
import { eventData } from '../../scripts/fixture/write';
import type { Db, Row } from '../../scripts/lib/db';
import { LAP_PANELS, LAP_RUN, onTheSeed, queries, SEED } from './test-seed';

describe('one-lap on the seed', () => {
  let db: Db;
  const sqlOf = (name: string) => queries.find(([n]) => n === name)?.[1] as string;
  const seed = SEED;
  const [running] = seedLaps(seed)
    .filter((l) => l.what === 'running')
    .map((l) => l.runId)
    .sort();
  const lap = (name: string, runId: string, factory = 'mission-control') =>
    db.query(sqlOf(name), [factory, runId]);
  const errors = () => db.query('SELECT source, message FROM mc.projection_errors ORDER BY id');
  const reviewEvent = (event: 'node_started' | 'node_completed', at: string) =>
    db.query(
      `INSERT INTO remote_agent_workflow_events (workflow_run_id, event_type, step_name, data)
       VALUES ($1, $2, 'review', $3::jsonb)`,
      [running, event, JSON.stringify(eventData('review', event, new Date(at)))],
    );
  const reviews = async () =>
    (await lap('one-lap-steps', running)).filter((s) => s.step_id === 'review');

  beforeAll(async () => {
    db = await onTheSeed();
  }, 60_000);

  afterAll(() => db.close());

  test('the seed has the gate-refused lap, with an old holdout line, these tests read', async () => {
    const [refused] = await db.query(
      `SELECT l.run_id::text AS run_id FROM mc.laps l
       JOIN mc.lap_steps land ON land.run_id = l.run_id AND land.step_id = 'land'
       WHERE l.factory = 'mission-control' AND land.output ->> 'outcome' = 'refused'
         AND EXISTS (SELECT 1 FROM mc.app_check_lines a
                      WHERE a.run_id = l.run_id AND a.kind = 'holdout')
       ORDER BY l.run_id LIMIT 1`,
    );
    expect(refused.run_id).toBe(LAP_RUN);
    expect(seedLaps(seed).find((l) => l.runId === LAP_RUN)?.what).toBe('gate-refused');
  });

  test('an item delivered by a merged pull request that only Refs it has that merge as its merged time', async () => {
    const read = async () => {
      const [row] = await lap('one-lap', LAP_RUN);
      return [row.item_merged_at, row.closed_by];
    };
    const before = await read();
    const links = await db.query(
      `SELECT factory, pr_number FROM mc.pull_request_issues WHERE factory = 'mission-control' AND issue_number = 3`,
    );
    expect(links).toHaveLength(1);
    const [{ pr_number }] = links;
    await db.query(
      `DELETE FROM mc.pull_request_issues WHERE factory = 'mission-control' AND issue_number = 3`,
    );
    expect((await read())[0]).toBeNull();
    await db.query(
      `INSERT INTO mc.pull_request_references (factory, pr_number, issue_number) VALUES ('mission-control', $1, 3)`,
      [pr_number],
    );
    expect(await read()).toEqual(before);
    await db.query(
      `DELETE FROM mc.pull_request_references WHERE factory = 'mission-control' AND issue_number = 3`,
    );
    await db.query(
      `INSERT INTO mc.pull_request_issues (factory, pr_number, issue_number) VALUES ('mission-control', $1, 3)`,
      [pr_number],
    );
    expect(await read()).toEqual(before);
  });

  describe('an item delivered by Refs-linked pull requests', () => {
    const FAILED = '5eed0001-0000-4000-8000-000000000006';
    const CLOSER = '5eed0001-0000-4000-8000-00000000000b';
    const setMerged = (n: number, at: string) =>
      db.query(
        `UPDATE mc.pull_requests SET merged_at = $1::timestamptz WHERE factory = 'mission-control' AND number = $2`,
        [at, n],
      );
    const read = async (runId: string) => {
      const [row] = await lap('one-lap', runId);
      return row;
    };
    let originalReason: unknown;
    beforeAll(async () => {
      [{ close_reason: originalReason }] = await db.query(
        `SELECT close_reason FROM mc.issues WHERE factory = 'mission-control' AND number = 3`,
      );
    });
    const asRefsOnly = async () => {
      const [{ pr_number }] = await db.query(
        `SELECT pr_number FROM mc.pull_request_issues WHERE factory = 'mission-control' AND issue_number = 3`,
      );
      await db.query(
        `DELETE FROM mc.pull_request_issues WHERE factory = 'mission-control' AND issue_number = 3`,
      );
      await db.query(
        `INSERT INTO mc.pull_request_references (factory, pr_number, issue_number) VALUES ('mission-control', $1, 3)`,
        [pr_number],
      );
      return async () => {
        await db.query(
          `DELETE FROM mc.pull_request_references WHERE factory = 'mission-control' AND issue_number = 3`,
        );
        await db.query(
          `INSERT INTO mc.pull_request_issues (factory, pr_number, issue_number) VALUES ('mission-control', $1, 3)`,
          [pr_number],
        );
        await setMerged(Number(pr_number), '2026-10-02T07:30:00Z');
      };
    };

    test('a Refs-only merge decides the closing run of a failed run', async () => {
      const restore = await asRefsOnly();
      try {
        await setMerged(103, '2026-10-02T06:58:00Z');
        expect((await read(FAILED)).closed_by).toBe(CLOSER);
        // No completed run spans 05:00: the sentence names no run.
        await setMerged(103, '2026-10-02T05:00:00Z');
        expect((await read(FAILED)).closed_by).toBeNull();
      } finally {
        await restore();
      }
    });

    test('the item merged time is the latest of its Closes and Refs merges, in either order', async () => {
      const [{ number: other }] = await db.query(
        `SELECT number FROM mc.pull_requests
         WHERE factory = 'mission-control' AND merged_at IS NOT NULL AND number <> 103 ORDER BY number LIMIT 1`,
      );
      const [{ merged_at: otherAt }] = await db.query(
        `SELECT merged_at FROM mc.pull_requests WHERE factory = 'mission-control' AND number = $1`,
        [other],
      );
      await db.query(
        `INSERT INTO mc.pull_request_references (factory, pr_number, issue_number) VALUES ('mission-control', $1, 3)`,
        [other],
      );
      try {
        await setMerged(103, '2026-10-02T06:00:00Z');
        await setMerged(Number(other), '2026-10-02T07:00:00Z');
        expect((await read(LAP_RUN)).item_merged_at).toEqual(new Date('2026-10-02T07:00:00Z'));
        await setMerged(Number(other), '2026-10-02T05:00:00Z');
        expect((await read(LAP_RUN)).item_merged_at).toEqual(new Date('2026-10-02T06:00:00Z'));
      } finally {
        await db.query(
          `DELETE FROM mc.pull_request_references WHERE factory = 'mission-control' AND pr_number = $1 AND issue_number = 3`,
          [other],
        );
        await setMerged(Number(other), (otherAt as Date).toISOString());
        await setMerged(103, '2026-10-02T07:30:00Z');
      }
    });

    test('a Refs merge does not deliver an item closed as not planned or a duplicate', async () => {
      const restore = await asRefsOnly();
      try {
        for (const [reason, merged] of [
          ['not_planned', false],
          ['duplicate', false],
          ['completed', true],
        ] as const) {
          await db.query(
            `UPDATE mc.issues SET close_reason = $1 WHERE factory = 'mission-control' AND number = 3`,
            [reason],
          );
          expect([reason, (await read(LAP_RUN)).item_merged_at !== null]).toEqual([reason, merged]);
        }
      } finally {
        await db.query(
          `UPDATE mc.issues SET close_reason = $1 WHERE factory = 'mission-control' AND number = 3`,
          [originalReason],
        );
        await restore();
      }
    });
  });

  test("the header is the gate-refused lap's claim, pick, review and merge gate", async () => {
    expect(await lap('one-lap', LAP_RUN)).toEqual([
      {
        run_id: LAP_RUN,
        workflow_name: 'archon-loop',
        status: 'completed',
        started_at: new Date('2026-10-01T14:00:00Z'),
        completed_at: new Date('2026-10-01T15:00:00Z'),
        repository: 'coleam00/factory-mission-control',
        console: 'http://localhost:3090',
        issue_number: 3,
        issue_title: 'A migrations runner that refuses main',
        issue_url: 'https://github.com/coleam00/factory-mission-control/issues/3',
        route: 'simple',
        depth: 'normal',
        pr_number: 103,
        pr_state: 'merged',
        review_status: 'completed',
        review_outcome: 'merge',
        review_delivers: 'all',
        dispositions: [],
        hidden_lines: ['H1'],
        gate_status: 'completed',
        gate_outcome: 'refused',
        gate_reason: 'it changes .claude/settings.json, which only the owner changes',
        stop_status: 'completed',
        stop_step: null,
        stop_line: null,
        stop_class: null,
        capacity_since: null,
        item_closed_at: new Date('2026-10-02T07:30:00Z'),
        item_merged_at: new Date('2026-10-02T07:30:00Z'),
        item_pr: null,
        finished_by: null,
        finished_at: null,
        closed_by: null,
      },
    ]);
  });

  test("the steps are the lap's attempts, with each step's model and tokens", async () => {
    const steps = await lap('one-lap-steps', LAP_RUN);
    const attempts = await db.query(
      `SELECT step_id, status, nullif(started_at, '-infinity') AS started_at, duration_ms, cost_usd
       FROM mc.lap_step_attempts WHERE run_id = $1 ORDER BY step_id`,
      [LAP_RUN],
    );
    expect(attempts.length).toBeGreaterThan(0);
    const byStep = [...steps].sort((a, b) => String(a.step_id).localeCompare(String(b.step_id)));
    expect(
      byStep.map(
        ({ step_id, status, started_at, duration_ms, cost_usd }): Row => ({
          step_id,
          status,
          started_at,
          duration_ms,
          cost_usd,
        }),
      ),
    ).toEqual(attempts);
    expect(
      byStep.map(
        (s): Row => ({
          step_id: s.step_id,
          model: s.model,
          tokens_input: s.tokens_input,
          tokens_output: s.tokens_output,
          tokens_cache_read: s.tokens_cache_read,
          tokens_cache_write: s.tokens_cache_write,
        }),
      ),
    ).toEqual(
      await db.query(
        `SELECT step_id, model, tokens_input, tokens_output, tokens_cache_read, tokens_cache_write
         FROM mc.lap_steps WHERE run_id = $1 ORDER BY step_id`,
        [LAP_RUN],
      ),
    );
  });

  test("steps that ran go by start, then the steps that never started in the loop's order (#191)", async () => {
    const order = async (runId: string) =>
      attemptsInOrder((await lap('one-lap-steps', runId)) as unknown as StepAttemptRow[]).map(
        (s) => s.step_id,
      );
    // The failed lap stopped at build; the sent-back lap skipped ship, land and deploy.
    expect(await order('5eed0003-0000-4000-8000-000000000002')).toEqual([
      'pick',
      'claim',
      'build',
      'ship',
      'subject',
      'check-app',
      'evidence',
      'review',
      'land',
      'deploy',
      'release',
      'tally',
    ]);
    expect(await order('5eed0002-0000-4000-8000-000000000003')).toEqual([
      'pick',
      'claim',
      'build',
      'subject',
      'check-app',
      'evidence',
      'review',
      'release',
      'tally',
      'ship',
      'land',
      'deploy',
    ]);
  });

  test('the app-check lines are kind, verdict and evidence, never text or an old holdout line', async () => {
    const lines = await lap('one-lap-checks', LAP_RUN);
    expect(lines).toEqual(
      await db.query(
        `SELECT position, line_id, kind, verdict, evidence_count
         FROM mc.app_check_lines WHERE run_id = $1 AND kind <> 'holdout' ORDER BY position`,
        [LAP_RUN],
      ),
    );
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line).not.toHaveProperty('pre_existing');
  });

  test("a sent-back lap's review shows no disposition for the old holdout line it blocks on", async () => {
    const [sentBack] = await lap('one-lap', '5eed0001-0000-4000-8000-000000000001');
    expect(sentBack.review_outcome).toBe('sent-back');
    expect(shownDispositions(sentBack as never)).toEqual([]);
  });

  test("every seed lap's shown review disposition names exactly one shown app-check line", async () => {
    for (const { runId } of seedLaps(seed)) {
      const [header] = await lap('one-lap', runId);
      const lines = await lap('one-lap-checks', runId);
      for (const { line } of shownDispositions(header as never)) {
        if (line === null) continue;
        expect([runId, line, lines.filter((l) => l.line_id === line).length]).toEqual([
          runId,
          line,
          1,
        ]);
      }
    }
  });

  test("the old holdout line a sent-back lap's review blocks on is not shown", async () => {
    const lines = await lap('one-lap-checks', '5eed0001-0000-4000-8000-000000000001');
    expect(lines.filter((l) => l.line_id === 'H2')).toEqual([]);
    expect(lines.filter((l) => l.kind === 'holdout')).toEqual([]);
  });

  test('another factory and a malformed run id find no lap, without an error', async () => {
    for (const name of LAP_PANELS) {
      expect([name, await lap(name, LAP_RUN, 'other')]).toEqual([name, []]);
      expect([name, await lap(name, 'not-a-uuid')]).toEqual([name, []]);
    }
  });

  test('a review node_started adds one running review row; a second moves its start', async () => {
    const before = await errors();
    expect(await reviews()).toEqual([]);
    await reviewEvent('node_started', '2026-10-25T12:00:00Z');
    const [first, ...more] = await reviews();
    expect(more).toEqual([]);
    expect([first.status, first.started_at]).toEqual([
      'running',
      new Date(Date.parse('2026-10-25T12:00:00Z') - 184_250),
    ]);
    await reviewEvent('node_started', '2026-10-25T12:10:00Z');
    const [moved, ...again] = await reviews();
    expect(again).toEqual([]);
    expect([moved.status, moved.started_at]).toEqual([
      'running',
      new Date(Date.parse('2026-10-25T12:10:00Z') - 184_250),
    ]);
    expect(await errors()).toEqual(before);
  });

  test('a repeated review shows both attempts, and the lap costs both', async () => {
    const before = await errors();
    await reviewEvent('node_completed', '2026-10-25T12:20:00Z');
    await reviewEvent('node_started', '2026-10-25T13:00:00Z');
    await reviewEvent('node_completed', '2026-10-25T13:20:00Z');
    const shown = (await reviews()).sort((a, b) => Number(a.started_at) - Number(b.started_at));
    expect(shown.map((r) => [r.status, r.started_at, r.model, r.tokens_input])).toEqual([
      // Each attempt shows what Archon recorded for it, the earlier one too (#201).
      ['completed', new Date(Date.parse('2026-10-25T12:20:00Z') - 184_250), 'sonnet', 48_210],
      ['completed', new Date(Date.parse('2026-10-25T13:20:00Z') - 184_250), 'sonnet', 48_210],
    ]);
    expect(shown.reduce((sum, r) => sum + Number(r.cost_usd), 0)).toBeCloseTo(0.8426);
    expect(await errors()).toEqual(before);
  });
  test("one-lap-map: the loop at the lap's own pin, every node", async () => {
    const pinOf = async (runId: string) => {
      const rows = await lap('one-lap-map', runId);
      return { rows, pins: [...new Set(rows.map((r) => r.pin))] };
    };
    // A lap of 10-01 ran under the pin of 09-30.
    const first = await pinOf(LAP_RUN);
    expect(first.pins).toEqual(['8e3e1cefaf1e1b7955789d6a43a81b6c2dbd7082']);
    const [{ n }] = await db.query(
      `SELECT count(*)::int AS n FROM mc.arch_steps
       WHERE workflow = 'archon-loop' AND archon_sha = 'abd85896e7971c9ac5199ed7e87973f27130250f'`,
    );
    expect(first.rows).toHaveLength(n as number);
    const intel = first.rows.find((r) => r.path === 'ship/intel');
    expect(intel).toMatchObject({ parent_path: 'ship' });
    // The running lap's pin of 10-19 has no architecture stored: the newest one before it is used.
    expect((await pinOf(running)).pins).toEqual(['5ffd60c6c6e591487f2fbb5ec67ccc8fc55ca915']);
    // No lap, no rows; another factory's lap is not this factory's.
    expect(await lap('one-lap-map', '5eed0001-0000-4000-8000-0000000000ff')).toEqual([]);
    expect(await lap('one-lap-map', LAP_RUN, 'second-factory')).toEqual([]);
  });
  test('each attempt of a step run twice shows its own model and tokens, none only where none', async () => {
    const before = await errors();
    const event = (type: string, at: string, data: object) =>
      db.query(
        `INSERT INTO remote_agent_workflow_events (workflow_run_id, event_type, step_name, data, created_at)
         VALUES ($1, $2, 'check-app', $3::jsonb, $4)`,
        [running, type, JSON.stringify(data), at],
      );
    const timing = (at: string) => ({ timing: { startedAt: at, durationMs: 60_000 } });
    // First run: the model only on its start, tokens on its finish.
    await event('node_started', '2026-10-25T14:00:00Z', {
      ...timing('2026-10-25T14:00:00Z'),
      model: 'haiku',
    });
    await event('node_completed', '2026-10-25T14:01:00Z', {
      ...timing('2026-10-25T14:00:00Z'),
      tokens: { input: 1000, output: 100 },
      cost_usd: 0.01,
    });
    // Second run: a resolved model on its finish, other tokens.
    await event('node_started', '2026-10-25T15:00:00Z', {
      ...timing('2026-10-25T15:00:00Z'),
      model: 'sonnet',
    });
    await event('node_completed', '2026-10-25T15:01:00Z', {
      ...timing('2026-10-25T15:00:00Z'),
      model_usage: { resolved: 'opus' },
      tokens: { input: 2000, output: 200, cacheRead: 50 },
      cost_usd: 0.02,
    });
    // Third run: Archon recorded no model and no tokens.
    await event('node_started', '2026-10-25T16:00:00Z', timing('2026-10-25T16:00:00Z'));
    await event('node_completed', '2026-10-25T16:01:00Z', timing('2026-10-25T16:00:00Z'));
    const shown = (await lap('one-lap-steps', running))
      .filter(
        (s) =>
          s.step_id === 'check-app' && Number(s.started_at) >= Date.parse('2026-10-25T14:00:00Z'),
      )
      .sort((a, b) => Number(a.started_at) - Number(b.started_at))
      .map((r) => [
        r.model,
        r.tokens_input,
        r.tokens_output,
        r.tokens_cache_read,
        Number(r.cost_usd),
      ]);
    expect(shown).toEqual([
      ['haiku', 1000, 100, null, 0.01],
      ['opus', 2000, 200, 50, 0.02],
      [null, null, null, null, 0],
    ]);
    expect(await errors()).toEqual(before);
  });

  test('every lap and merged run on the map opens its page', async () => {
    let seen = 0;
    for (const factory of ['mission-control', 'second-factory', 'queue-factory']) {
      const map = await db.query(queries.find(([n]) => n === 'home-map')?.[1] as string, [
        factory,
        '',
      ]);
      for (const row of map.filter((r) => r.kind === 'lap' || r.kind === 'merged')) {
        if (row.run_id === null) continue;
        expect([row.run_id, (await lap('one-lap', String(row.run_id), factory)).length]).toEqual([
          row.run_id,
          1,
        ]);
        seen++;
      }
    }
    expect(seen).toBeGreaterThan(0);
  });

  const queue = (name: string, runId: string) => lap(name, runId, 'queue-factory');

  test('the failed build-queue run opens with its workflow, item, pull request and stop record', async () => {
    const [run] = await queue('one-lap', QUEUE_RUNS.failedBuild);
    expect(run).toMatchObject({
      workflow_name: 'archon-build-queue',
      status: 'failed',
      issue_number: QUEUE_PAGE_RUNS.buildIssue,
      pr_number: 496,
      pr_state: null,
      stop_status: 'failed',
      stop_step: 'ship__deliver__rounds.pr__prepare',
      stop_line: "Script node 'pr__prepare' failed [exit 1]",
      stop_class: 'environment',
    });
  });

  test('a run in capacity_waits carries when it began waiting, and another run carries none', async () => {
    const [waiting] = await queue('one-lap', QUEUE_RUNS.capacity);
    expect(waiting.capacity_since).toEqual(new Date(QUEUE_UNSTICK.capacitySince));
    const [failed] = await queue('one-lap', QUEUE_RUNS.failedBuild);
    expect(failed.capacity_since).toBeNull();
  });

  test('the app check run names its pull request', async () => {
    const [run] = await queue('one-lap', QUEUE_RUNS.appCheck);
    expect(run).toMatchObject({
      workflow_name: 'factory-app-check',
      pr_number: Number(QUEUE_PAGE_RUNS.checkPr),
    });
  });

  test("a run's cost is the sum of its step costs, a loop's roll-up left out", async () => {
    const rows = (await queue(
      'one-lap-steps',
      QUEUE_RETURNED.first,
    )) as unknown as StepAttemptRow[];
    const [attempts] = await db.query(
      'SELECT sum(cost_usd) AS cost FROM mc.lap_step_attempts WHERE run_id = $1',
      [QUEUE_RETURNED.first],
    );
    const group = rows.find((r) => r.step_id === 'ship__deliver__rounds');
    // mc.lap_steps still holds the loop's roll-up, which the page must not count again.
    const [rollUp] = await db.query(
      'SELECT cost_usd FROM mc.lap_steps WHERE run_id = $1 AND step_id = $2',
      [QUEUE_RETURNED.first, 'ship__deliver__rounds'],
    );
    expect(Number(rollUp?.cost_usd)).toBe(1.5);
    expect(stepCost(group as StepAttemptRow, rows)).toBeNull();
    expect(runCost(rows)).toBeCloseTo(Number(attempts?.cost), 6);
    expect(runCost(rows)).toBeCloseTo(2.2, 6);
  });

  test('the finished build run reads its item, pull request, rounds and cost', async () => {
    const [run] = await queue('one-lap', QUEUE_RETURNED.second);
    const rows = (await queue(
      'one-lap-steps',
      QUEUE_RETURNED.second,
    )) as unknown as StepAttemptRow[];
    const read = managerRead(run as unknown as OneLapRow, rows, runTimeline(rows));
    expect(read.parts.map((p) => p.text).join('')).toBe(
      'It finished work on #407 (Queue issue 407) in 1 round, for $2.20. PR #410 is merged.',
    );
  });

  test('the failed build run is two rounds, its review skipped for the failure upstream', async () => {
    const rows = (await queue(
      'one-lap-steps',
      QUEUE_RUNS.failedBuild,
    )) as unknown as StepAttemptRow[];
    const timeline = runTimeline(rows);
    const loop = timeline.find((e) => e.kind === 'loop');
    expect(loop?.kind === 'loop' ? loop.rounds.map((r) => r.failed) : []).toEqual([false, true]);
    expect(rows.find((r) => r.status === 'failed')?.error).toBe(QUEUE_PAGE_RUNS.buildError);
    expect(rows.filter((r) => r.status === 'skipped').map((r) => r.step_id)).toEqual([
      'ship__deliver__rounds.review__publish',
    ]);
    const steps = timeline.flatMap((e) =>
      e.kind === 'step' ? [e.row] : e.rounds.flatMap((r) => r.rows),
    );
    expect(steps.reduce((sum, r) => sum + (stepCost(r, rows) ?? 0), 0)).toBeCloseTo(
      runCost(rows) ?? Number.NaN,
      6,
    );
  });

  test("the failed build's map holds the deliver loop's cap of 4 from the queue pack's own version", async () => {
    const rows = await lap('one-lap-map', QUEUE_RUNS.failedBuild, 'queue-factory');
    expect(rows.find((r) => r.path === 'ship/deliver/rounds')?.round_cap).toBe(4);
  });

  test("every build-queue step page's Prompt and Scripts resolve to its own version's file, at the address the run page links", async () => {
    const queueRoot = join(import.meta.dir, '../../fixtures/pack/queue/sdlc');
    const [first] = await queue('one-lap-map', QUEUE_RUNS.failedBuild);
    expect(first?.pin).toBeNull();
    const at = String(first?.archon_sha);
    const steps = await db.query(
      `SELECT s.path, s.script_file, s.command_file
       FROM mc.arch_steps s
       WHERE s.workflow = 'archon-build-queue' AND s.archon_sha = $1
         AND (s.script_file IS NOT NULL OR s.command_file IS NOT NULL)`,
      [at],
    );
    expect(steps.length).toBeGreaterThan(0);
    const notFound: string[] = [];
    const mismatch: string[] = [];
    for (const step of steps) {
      const isScript = step.script_file !== null;
      const file = String(isScript ? step.script_file : step.command_file);
      const chunks = await db.query(sqlOf(isScript ? 'step-scripts' : 'step-prompt'), [
        'queue-factory',
        'archon-build-queue',
        step.path,
        at,
      ]);
      const text = chunks
        .filter((c) => c.path === file)
        .sort((a, b) => Number(a.part) - Number(b.part))
        .map((c) => c.chunk)
        .join('');
      if (text === '') notFound.push(`${step.path}: ${file}`);
      else if (text !== readFileSync(join(queueRoot, file), 'utf8').replaceAll('\r\n', '\n'))
        mismatch.push(`${step.path}: ${file}`);
    }
    expect(notFound).toEqual([]);
    expect(mismatch).toEqual([]);
    const details = await db.query(sqlOf('step-detail'), ['queue-factory', at]);
    expect(details.map((d) => d.workflow)).toContain('archon-build-queue');
  });

  test('every workflow a queue-factory lap ran has steps at the queue version, so no lap draws another pack', async () => {
    const [held] = await db.query(
      `SELECT array_agg(DISTINCT l.workflow_name) AS missing
       FROM mc.laps l
       WHERE l.factory = 'queue-factory' AND NOT EXISTS (
         SELECT 1 FROM mc.arch_steps s
         JOIN mc.arch_versions a ON a.archon_sha = s.archon_sha AND a.factory_sha = s.factory_sha
         WHERE s.workflow = l.workflow_name AND NOT EXISTS (SELECT 1 FROM mc.pins p WHERE p.archon_sha = a.archon_sha))`,
    );
    expect(held?.missing ?? null).toBeNull();
  });

  test("a queue factory's merge-queue map holds facts and sweep", async () => {
    const rows = await lap('one-lap-map', QUEUE_RUNS.merged, 'queue-factory');
    expect(rows.map((r) => r.step_id)).toEqual(expect.arrayContaining(['facts', 'sweep']));
  });
  // A copy of one version's steps under a new factory_sha (and workflow), as a parse of its own.
  const parseOf = async (
    from: { archon: string; workflow: string },
    to: { factory: string; workflow: string; parsedAt: string; archon?: string },
  ) => {
    await db.query(
      `INSERT INTO mc.arch_versions (archon_sha, factory_sha, parsed_at) VALUES ($1, $2, $3)`,
      [to.archon ?? from.archon, to.factory, to.parsedAt],
    );
    await db.query(
      `CREATE TEMP TABLE copy AS SELECT * FROM mc.arch_steps WHERE archon_sha = $1 AND workflow = $2`,
      [from.archon, from.workflow],
    );
    await db.query(`UPDATE copy SET archon_sha = $1, factory_sha = $2, workflow = $3`, [
      to.archon ?? from.archon,
      to.factory,
      to.workflow,
    ]);
    await db.query(`INSERT INTO mc.arch_steps SELECT * FROM copy`);
    await db.query(`DROP TABLE copy`);
  };
  const lapOf = (runId: string, factory: string, workflow: string, startedAt: string) =>
    db.query(
      `INSERT INTO mc.laps (run_id, factory, workflow_name, status, started_at) VALUES ($1, $2, $3, 'completed', $4)`,
      [runId, factory, workflow, startedAt],
    );

  test('a version no pin names is drawn only on a factory on the queues', async () => {
    const loop = { archon: 'abd85896e7971c9ac5199ed7e87973f27130250f', workflow: 'archon-loop' };
    await parseOf(loop, {
      factory: 'unpinned-parse',
      workflow: 'unpinned-only',
      parsedAt: '2026-01-01T00:00:00Z',
      archon: 'beef000000000000000000000000000000000001',
    });
    const plain = '5eed0001-0000-4000-8000-0000000000a1';
    const queued = '5eed0001-0000-4000-8000-0000000000a2';
    await lapOf(plain, 'plain-factory', 'unpinned-only', '2026-10-01T00:00:00Z');
    await lapOf(queued, 'queued-factory', 'unpinned-only', '2026-10-01T00:00:00Z');
    await lapOf(
      '5eed0001-0000-4000-8000-0000000000a3',
      'queued-factory',
      'archon-intake',
      '2026-10-01T00:00:00Z',
    );
    for (const name of ['one-lap-map', 'one-lap-steps']) {
      const rows = (runId: string, factory: string) => db.query(sqlOf(name), [factory, runId]);
      expect(await rows(plain, 'plain-factory')).toEqual([]);
    }
    expect((await lap('one-lap-map', queued, 'queued-factory')).length).toBeGreaterThan(0);
  });

  test('the map and the steps resolve a lap to the same newest parse of its pin, even one parsed after the lap', async () => {
    const archon = 'abd85896e7971c9ac5199ed7e87973f27130250f';
    await parseOf(
      { archon, workflow: 'archon-loop' },
      { factory: 'newest-parse', workflow: 'archon-loop', parsedAt: '2099-01-01T00:00:00Z' },
    );
    await db.query(
      `UPDATE mc.arch_steps SET path = 'zz-newest', step_id = 'zz-newest', parent_path = NULL, position = 999 WHERE factory_sha = 'newest-parse' AND path = 'ship/intel'`,
    );
    const run = '5eed0001-0000-4000-8000-0000000000b1';
    await lapOf(run, 'mission-control', 'archon-loop', '2026-10-01T00:00:00Z');
    await db.query(
      `INSERT INTO mc.lap_steps (run_id, step_id, status) VALUES ($1, 'zz-newest', 'completed')`,
      [run],
    );
    const mapped = await lap('one-lap-map', run);
    expect(mapped.map((r) => r.path)).toContain('zz-newest');
    const listed = await lap('one-lap-steps', run);
    expect(listed.find((r) => r.step_id === 'zz-newest')?.position).toBe(999);
  });
});
