import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { HomeMapRow } from '../../app/map/live';
import { QUEUE_RUNS } from '../../scripts/fixture/seed';
import type { Db } from '../../scripts/lib/db';
import { onTheSeed, queries } from './test-seed';

const sql = queries.find(([name]) => name === 'home-map')?.[1] as string;
const V1 = '8e3e1cefaf1e1b7955789d6a43a81b6c2dbd7082';
const V2 = '5ffd60c6c6e591487f2fbb5ec67ccc8fc55ca915';
const V3 = '58c5f774e1bbe57c80c85ee91df8d44075664232';

describe('home-map on the seed', () => {
  let db: Db;
  const rows = async (factory = 'mission-control', pin = '') =>
    (await db.query(sql, [factory, pin])) as unknown as HomeMapRow[];
  /** Each running lap as `<workflow> <running steps>`, by run. */
  const laps = async (factory = 'mission-control', pin = '') =>
    Object.fromEntries(
      (await rows(factory, pin))
        .filter((r) => r.kind === 'lap')
        .map((r) => [r.run_id, `${r.workflow} ${(r.steps ?? []).join(',')}`]),
    );
  const versions = async (factory: string, pin: string) =>
    (await rows(factory, pin)).filter((r) => r.kind === 'version').length;

  beforeAll(async () => {
    db = await onTheSeed();
  }, 60_000);
  afterAll(() => db.close());

  test("the factory's running laps with their running steps, and no other factory's", async () => {
    expect(await laps()).toEqual({
      '5eed0003-0000-4000-8000-00000000000a': 'archon-loop build',
      '5eed0003-0000-4000-8000-00000000000b': 'archon-loop check-app',
    });
    expect(await laps('second-factory')).toEqual({
      '5eed0004-0000-4000-8000-000000000000': 'archon-loop claim',
    });
  });

  test('a lap carries the issue its claim names', async () => {
    const [claimed] = await db.query(
      `SELECT c.run_id, c.issue_number, i.title FROM mc.claims c
        JOIN mc.laps l ON l.run_id = c.run_id AND l.status = 'running'
        JOIN mc.issues i ON i.factory = c.factory AND i.number = c.issue_number
        WHERE c.factory = 'mission-control' LIMIT 1`,
    );
    const row = (await rows()).find((r) => r.run_id === claimed?.run_id);
    expect(row).toMatchObject({ number: claimed?.issue_number, title: claimed?.title });
  });

  test('a queue factory: its runs carry the issue of their number input, it is on the queues, one run waits, one merged two pulls', async () => {
    const queue = await rows('queue-factory');
    expect(await laps('queue-factory')).toEqual({
      [QUEUE_RUNS.build]: 'archon-build-queue ',
      [QUEUE_RUNS.review]: 'archon-build-queue ',
      [QUEUE_RUNS.ask]: 'archon-build-queue ',
    });
    expect(
      queue
        .filter((r) => r.kind === 'lap')
        .map((r) => [r.number, r.title])
        .sort(),
    ).toEqual([
      [401, 'Queue issue 401'],
      [402, 'Queue issue 402'],
      [403, 'Queue issue 403'],
    ]);
    expect(queue.filter((r) => r.kind === 'queues')).toHaveLength(1);
    expect(queue.filter((r) => r.kind === 'waiting')).toMatchObject([
      { run_id: QUEUE_RUNS.waiting, workflow: 'archon-merge-queue', number: null },
    ]);
    expect(queue.filter((r) => r.kind === 'merged')).toMatchObject([
      { run_id: QUEUE_RUNS.merged, prs: '[404, 405]' },
    ]);
  });

  test('a factory on the old loop has no queues row, no waiting row and merges only through land', async () => {
    for (const factory of ['mission-control', 'second-factory']) {
      const kinds = new Set((await rows(factory)).map((r) => r.kind));
      expect(kinds.has('queues')).toBe(false);
      expect(kinds.has('waiting')).toBe(false);
    }
    expect((await rows()).filter((r) => r.kind === 'merged').every((r) => r.prs === null)).toBe(
      true,
    );
  });

  test('answering an attention wait takes the run off waiting', async () => {
    await db.query(
      `UPDATE remote_agent_workflow_runs
         SET metadata = jsonb_set(metadata, '{wait,answer}', '{"text":"yes"}'::jsonb) WHERE id = $1`,
      [QUEUE_RUNS.waiting],
    );
    try {
      expect((await rows('queue-factory')).filter((r) => r.kind === 'waiting')).toEqual([]);
    } finally {
      await db.query(
        `UPDATE remote_agent_workflow_runs SET metadata = metadata #- '{wait,answer}' WHERE id = $1`,
        [QUEUE_RUNS.waiting],
      );
    }
  });

  test.each(['mission-control', 'queue-factory'])(
    'runs in under 100 ms on the seed for %s',
    async (factory) => {
      const plan = await db.query(
        `EXPLAIN ANALYZE ${sql}`.replace(/\$1/g, `'${factory}'`).replace(/\$2/g, "''"),
      );
      const time = plan
        .map((r) => String(Object.values(r)[0]))
        .find((line) => line.startsWith('Execution Time'));
      expect(Number.parseFloat(time?.replace('Execution Time: ', '') ?? 'NaN')).toBeLessThan(100);
    },
  );

  test('failing: each open pull request whose latest app check is FAIL, as SQL over the seed says', async () => {
    const recount = await db.query(
      `SELECT pr.number FROM mc.pull_requests pr
        WHERE pr.factory = 'mission-control' AND pr.state = 'open'
          AND (SELECT s.output ->> 'overall' FROM mc.lap_steps s JOIN mc.laps l USING (run_id)
                WHERE l.factory = pr.factory AND s.step_id = 'check-app'
                  AND s.output ->> 'pr' = '#' || pr.number
                ORDER BY s.started_at DESC LIMIT 1) = 'FAIL'`,
    );
    const failing = (await rows()).filter((r) => r.kind === 'failing').map((r) => r.number);
    expect(failing).toEqual(recount.map((r) => r.number as number));
    expect(failing).toEqual([109]);
  });

  test('a later passing check takes a pull request off failing', async () => {
    const [lap] = await db.query(
      `SELECT run_id FROM mc.laps WHERE factory = 'mission-control' AND status = 'completed' LIMIT 1`,
    );
    await db.query(
      `INSERT INTO mc.lap_steps (run_id, step_id, status, started_at, output)
        VALUES ($1, 'check-app', 'completed', '2026-10-30T00:00:00Z', '{"pr":"#109","overall":"PASS"}')
        ON CONFLICT (run_id, step_id) DO UPDATE SET started_at = EXCLUDED.started_at, output = EXCLUDED.output`,
      [lap?.run_id],
    );
    expect((await rows()).filter((r) => r.kind === 'failing')).toEqual([]);
  });

  test('merged: each lap whose land step merged, timed when the land step finished, running laps too', async () => {
    const recount = await db.query(
      `SELECT l.run_id, s.completed_at FROM mc.laps l JOIN mc.lap_steps s USING (run_id)
        WHERE l.factory = 'mission-control' AND s.step_id = 'land' AND s.status = 'completed'
          AND s.output ->> 'outcome' = 'merged'
        ORDER BY s.completed_at DESC, l.run_id`,
    );
    const merged = async () =>
      (await rows()).filter((r) => r.kind === 'merged').map((r): unknown[] => [r.run_id, r.at]);
    expect(await merged()).toEqual(recount.map((r) => [r.run_id, r.completed_at]));
    expect(recount.length).toBeGreaterThan(0);
    const [running] = await db.query(
      `SELECT run_id FROM mc.laps WHERE factory = 'mission-control' AND status = 'running' LIMIT 1`,
    );
    await db.query(
      `INSERT INTO mc.lap_steps (run_id, step_id, status, started_at, completed_at, output)
        VALUES ($1, 'land', 'completed', '2026-11-03T10:00:00Z', '2026-11-03T10:02:00Z', '{"outcome":"merged"}')`,
      [running?.run_id],
    );
    try {
      expect((await merged())[0]).toEqual([running?.run_id, new Date('2026-11-03T10:02:00Z')]);
    } finally {
      await db.query(`DELETE FROM mc.lap_steps WHERE run_id = $1 AND step_id = 'land'`, [
        running?.run_id,
      ]);
    }
  });

  test('the current version is recorded for a factory with laps; a factory with none has no version', async () => {
    expect(await versions('mission-control', '')).toBe(1);
    expect(await versions('zero-laps', '')).toBe(0);
  });

  test('a pin with architecture is recorded; one with none, an unknown value and a short sha are not', async () => {
    expect(await versions('mission-control', V1)).toBe(1);
    expect(await versions('mission-control', V2)).toBe(1);
    for (const pin of [V3, 'nope', V1.slice(0, 8)]) {
      expect(await versions('mission-control', pin)).toBe(0);
    }
  });

  test('at a pin only the laps that ran it count', async () => {
    expect(await laps('mission-control', V1)).toEqual({});
    const run = '00000000-0000-0000-0000-0000000000a1';
    await db.query(
      `INSERT INTO mc.laps (run_id, factory, workflow_name, status, digest) VALUES
        ($1, 'mission-control', 'archon-loop', 'running', 'sha256:${'a1'.repeat(32)}')`,
      [run],
    );
    await db.query(
      `INSERT INTO mc.lap_steps (run_id, step_id, status) VALUES ($1, 'check-app', 'running')`,
      [run],
    );
    expect(await laps('mission-control', V1)).toEqual({ [run]: 'archon-loop check-app' });
    expect(await laps('mission-control', V2)).toEqual({});
    expect(Object.keys(await laps())).toContain(run);
  });

  test('a step event projected for a running lap shows as its newest running step', async () => {
    const run = '5eed0003-0000-4000-8000-00000000000a';
    await db.query(
      `INSERT INTO remote_agent_workflow_events (workflow_run_id, event_type, step_name, data)
        VALUES ($1, 'node_started', 'review', '{"timing":{"startedAt":"2026-11-01T00:00:00.000Z"}}'::jsonb)`,
      [run],
    );
    expect((await laps())[run]).toBe('archon-loop review,build');
  });
});
