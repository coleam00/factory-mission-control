import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { HomeMapRow } from '../../app/map/live';
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
