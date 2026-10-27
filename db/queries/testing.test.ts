import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MARKER } from '../../scripts/fixture/seed-report';
import type { Db, Row } from '../../scripts/lib/db';
import { onTheSeed, queries } from './test-seed';

describe('the testing screen on the seed', () => {
  let db: Db;
  const sqlOf = (name: string) => queries.find(([n]) => n === name)?.[1] as string;
  const run = (name: string, factory = 'mission-control') => db.query(sqlOf(name), [factory]);
  const tally = (rows: readonly Row[], keys: readonly string[]) => {
    const counts: Record<string, number> = {};
    for (const row of rows) {
      const key = keys.map((k) => String(row[k])).join('/');
      counts[key] = (counts[key] ?? 0) + 1;
    }
    return counts;
  };

  beforeAll(async () => {
    db = await onTheSeed();
  }, 60_000);

  afterAll(() => db.close());

  test("every lap's route and depth, as the lanes read them, a lap not yet picked included", async () => {
    const rows = await run('testing-routes');
    const [{ laps }] = await db.query(
      `SELECT count(*)::int AS laps FROM mc.laps
       WHERE factory = 'mission-control' AND workflow_name = 'archon-loop'`,
    );
    expect(rows).toHaveLength(laps as number);
    expect(tally(rows, ['route', 'depth'])).toEqual({
      'simple/normal': 18,
      'continue/normal': 7,
      'none/light': 3,
      'complex/normal': 2,
      'null/null': 1,
    });
  });

  test("every app-check line of the factory's laps, by kind and verdict, with no text", async () => {
    const rows = await run('testing-app-check');
    const [{ lines }] = await db.query(
      `SELECT count(*)::int AS lines FROM mc.app_check_lines a JOIN mc.laps l USING (run_id)
       WHERE l.factory = 'mission-control' AND l.workflow_name = 'archon-loop'`,
    );
    expect(rows).toHaveLength(lines as number);
    expect(tally(rows, ['kind', 'verdict'])).toEqual({
      'criterion/PASS': 18,
      'probe/OK': 18,
      'holdout/PASS': 18,
      'holdout/FAIL': 5,
      'defect/DEFECT': 1,
    });
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(
        ['kind', 'position', 'pr', 'run_id', 'scenario_id', 'started_at', 'verdict'].sort(),
      );
      if (row.kind === 'holdout') expect(row.scenario_id).toMatch(/^(H-\d{2,}|unidentified)$/);
      else expect(row.scenario_id).toBeNull();
    }
    expect(JSON.stringify(rows)).not.toContain(MARKER);
  });

  test("the newest holdouts line's verdicts, its FAIL with the tracking issue", async () => {
    expect(await run('testing-holdouts')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sha: '3e4f5a6b', scenario_id: 'H-01', verdict: 'PASS' }),
        expect.objectContaining({
          sha: '3e4f5a6b',
          report_issue: 18,
          scenario_id: 'H-02',
          verdict: 'FAIL',
          issue_number: 14,
          issue_title: 'Phases and the issue graph',
          repository: 'coleam00/factory-mission-control',
        }),
        expect.objectContaining({ sha: '3e4f5a6b', scenario_id: 'H-04', verdict: 'PASS' }),
      ]),
    );
    expect(await run('testing-holdouts')).toHaveLength(3);
  });

  test('numbers never cross factories', async () => {
    expect(await run('testing-app-check', 'second-factory')).toEqual([]);
    expect(await run('testing-holdouts', 'second-factory')).toEqual([]);
    const routes = await run('testing-routes', 'second-factory');
    const [{ laps }] = await db.query(
      `SELECT count(*)::int AS laps FROM mc.laps
       WHERE factory = 'second-factory' AND workflow_name = 'archon-loop'`,
    );
    expect(routes).toHaveLength(laps as number);
    expect(routes.length).toBeGreaterThan(0);
  });

  test('a newer holdouts line replaces the older one', async () => {
    const [{ id }] = await db.query(
      `INSERT INTO mc.holdout_reports (factory, at, issue_number, sha)
       VALUES ('mission-control', '2026-10-25T09:00:00Z', 18, 'aaaabbbb') RETURNING id`,
    );
    await db.query(
      `INSERT INTO mc.holdout_verdicts (report_id, scenario_id, verdict) VALUES ($1, 'H-02', 'PASS')`,
      [id],
    );
    expect(await run('testing-holdouts')).toEqual([
      expect.objectContaining({ sha: 'aaaabbbb', scenario_id: 'H-02', verdict: 'PASS' }),
    ]);
  });
});
