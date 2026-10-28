import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
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

  test('the seed has the gate-refused lap with a holdout line these tests read', async () => {
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

  test("the header is the gate-refused lap's claim, pick, review and merge gate", async () => {
    expect(await lap('one-lap', LAP_RUN)).toEqual([
      {
        run_id: LAP_RUN,
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
        pr: '#103',
        review_status: 'completed',
        review_outcome: 'merge',
        review_delivers: 'all',
        dispositions: [],
        gate_status: 'completed',
        gate_outcome: 'refused',
        gate_reason: 'it changes .claude/settings.json, which only the owner changes',
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

  test('the app-check lines are kind, verdict, evidence and a holdout scenario id, never text', async () => {
    const lines = await lap('one-lap-checks', LAP_RUN);
    expect(lines).toEqual(
      await db.query(
        `SELECT position, kind, verdict, evidence_count, scenario_id
         FROM mc.app_check_lines WHERE run_id = $1 ORDER BY position`,
        [LAP_RUN],
      ),
    );
    expect(lines.some((l) => l.kind === 'holdout' && l.scenario_id === 'H-01')).toBe(true);
    for (const line of lines) expect(line).not.toHaveProperty('pre_existing');
  });

  test("a sent-back lap's review names the line each disposition answers", async () => {
    const [sentBack] = await lap('one-lap', '5eed0001-0000-4000-8000-000000000001');
    expect(sentBack.review_outcome).toBe('sent-back');
    expect(sentBack.dispositions).toEqual([{ line: 'H2', action: 'blocks' }]);
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
  test("one-lap-map: the loop at the lap's own pin, every node, each with its own screen", async () => {
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
    expect(intel).toMatchObject({ parent_path: 'ship', detail_path: 'intel' });
    expect(intel?.detail_workflow).not.toBe('archon-loop');
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
});
