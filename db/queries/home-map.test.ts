import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { HomeMapRow } from '../../app/lib/home-map';
import type { Db } from '../../scripts/lib/db';
import { onTheSeed, queries } from './test-seed';

describe('home-map on the seed', () => {
  let db: Db;
  const sql = queries.find(([name]) => name === 'home-map')?.[1] as string;
  type Row = Pick<
    HomeMapRow,
    | 'role'
    | 'path'
    | 'step_id'
    | 'workflow'
    | 'position'
    | 'detail_workflow'
    | 'lap_factory'
    | 'laps'
    | 'is_current'
  >;
  const rows = async (factory = 'mission-control') => (await db.query(sql, [factory])) as Row[];
  /** The address factory's laps on each node: the `laps` of its `is_current` row, else 0. */
  const liveCounts = async (factory = 'mission-control') => {
    const counts = new Map<string | null, number>();
    for (const row of await rows(factory)) {
      counts.set(row.path, row.is_current ? row.laps : (counts.get(row.path) ?? 0));
    }
    return counts;
  };

  beforeAll(async () => {
    db = await onTheSeed();
  }, 60_000);
  afterAll(() => db.close());

  test("shows the newest pin's architecture: V3 stores none, so V2's loop with ship expanded", async () => {
    const all = await rows();
    const ordered = (role: string) =>
      all
        .filter((r) => r.role === role)
        .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
        .map((r) => r.step_id);
    expect(ordered('step')).toEqual([
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
    expect(ordered('stage')).toEqual([
      'forge',
      'triage',
      'inv',
      'intel',
      'planned',
      'continues',
      'deliver',
      'outcome',
      'report',
    ]);
    expect(all.filter((r) => r.role === 'stage').map((r) => r.detail_workflow)).toEqual(
      Array(9).fill('archon-ship-block'),
    );
    expect(
      all
        .filter((r) => r.role === 'input' || r.role === 'manager')
        .map((r) => `${r.role} ${r.workflow}`)
        .sort(),
    ).toEqual(['input archon-backlog', 'input archon-holdouts', 'manager archon-manager']);
  });

  test('a factory with no laps has no map steps, even when shared architecture is stored', async () => {
    expect(await rows('empty-check')).toEqual([]);
    await db.query(`INSERT INTO mc.factories (name, repository, codebase, console)
      VALUES ('empty-check', 'o/empty', 'o/empty', 'http://localhost:3090')`);
    try {
      expect(await rows('empty-check')).toEqual([]);
      expect((await rows()).some((row) => row.step_id === 'check-app')).toBe(true);
      await db.query(`INSERT INTO mc.laps (run_id, factory, workflow_name, status) VALUES
        ('00000000-0000-0000-0000-000000000095', 'empty-check', 'archon-loop', 'completed')`);
      expect((await rows('empty-check')).map((row) => row.step_id).sort()).toEqual(
        (await rows()).map((row) => row.step_id).sort(),
      );
    } finally {
      await db.query("DELETE FROM mc.laps WHERE factory = 'empty-check'");
      await db.query("DELETE FROM mc.factories WHERE name = 'empty-check'");
    }
  });

  /** Running laps per node, from the laps tables: a node's own steps are named by its path joined with `__`. */
  const lapsOnNodes = async (factory: string) => {
    const running = (await db.query(
      `SELECT ls.run_id, ls.step_id FROM mc.lap_steps ls JOIN mc.laps l USING (run_id)
        WHERE l.factory = $1 AND l.workflow_name = 'archon-loop'
          AND l.status = 'running' AND ls.status = 'running'`,
      [factory],
    )) as { run_id: string; step_id: string }[];
    return (path: string) => {
      const key = path.replaceAll('/', '__');
      const on = running.filter((r) => r.step_id === key || r.step_id.startsWith(`${key}__`));
      return new Set(on.map((r) => r.run_id)).size;
    };
  };

  test("each step counts the factory's running laps on it now, as SQL over the seed does", async () => {
    const on = await lapsOnNodes('mission-control');
    expect([on('build'), on('check-app')]).toEqual([1, 1]);
    for (const [path, count] of await liveCounts()) {
      if (path !== null) expect(count).toBe(on(path));
    }
  });

  test('a lap on a ship stage counts on that stage and on ship, and nowhere else', async () => {
    const [lap] = await db.query(
      `SELECT l.run_id FROM mc.laps l JOIN mc.lap_steps ls USING (run_id)
        WHERE l.status = 'running' AND ls.step_id = 'check-app' AND ls.status = 'running'`,
    );
    await db.query(
      `INSERT INTO remote_agent_workflow_events (workflow_run_id, event_type, step_name, data)
        VALUES ($1, 'node_started', 'ship__intel', '{}'::jsonb)`,
      [lap.run_id],
    );
    const counts = await liveCounts();
    expect(counts.get('ship/intel')).toBe(1);
    expect(counts.get('ship')).toBe(1);
    expect(counts.get('intel')).toBeUndefined();
    const on = await lapsOnNodes('mission-control');
    for (const [path, count] of counts) if (path !== null) expect(count).toBe(on(path));
    await db.query(
      `INSERT INTO remote_agent_workflow_events (workflow_run_id, event_type, step_name, data)
        VALUES ($1, 'node_completed', 'ship__intel', '{}'::jsonb)`,
      [lap.run_id],
    );
    expect((await liveCounts()).get('ship/intel')).toBe(0);
  });

  test('a step event projected for a running lap adds it to that step, for that factory only', async () => {
    const [lap] = await db.query(
      `SELECT l.run_id FROM mc.laps l JOIN mc.lap_steps ls USING (run_id)
        WHERE l.status = 'running' AND ls.step_id = 'build' AND ls.status = 'running'`,
    );
    await db.query(
      `INSERT INTO remote_agent_workflow_events (workflow_run_id, event_type, step_name, data)
        VALUES ($1, 'node_started', 'review', '{}'::jsonb)`,
      [lap.run_id],
    );
    expect((await liveCounts()).get('review')).toBe(1);
    expect((await rows('second-factory')).filter((r) => r.step_id === 'review')).toEqual([
      expect.objectContaining({ lap_factory: 'mission-control', laps: 1, is_current: false }),
    ]);
    expect((await liveCounts('second-factory')).get('review')).toBe(0);
  });

  test("two factories: the header and each step count each factory's laps, the address factory current", async () => {
    const strip = queries.find(([name]) => name === 'status-strip')?.[1] as string;
    const [{ running: ours }] = await db.query(
      `SELECT count(*)::int AS running FROM mc.laps
        WHERE factory = 'mission-control' AND workflow_name = 'archon-loop' AND status = 'running'`,
    );
    const ourLaps = await lapsOnNodes('mission-control');
    expect([ourLaps('build'), ourLaps('deploy')]).toEqual([1, 0]);
    await db.query(`INSERT INTO mc.laps (run_id, factory, workflow_name, status) VALUES
      ('00000000-0000-0000-0000-0000000000c1', 'north-star', 'archon-loop', 'running'),
      ('00000000-0000-0000-0000-0000000000c2', 'north-star', 'archon-loop', 'running'),
      ('00000000-0000-0000-0000-0000000000c3', 'north-star', 'archon-loop', 'completed')`);
    await db.query(`INSERT INTO mc.lap_steps (run_id, step_id, status) VALUES
      ('00000000-0000-0000-0000-0000000000c1', 'build', 'running'),
      ('00000000-0000-0000-0000-0000000000c2', 'deploy', 'running'),
      ('00000000-0000-0000-0000-0000000000c3', 'deploy', 'running')`);

    expect(await db.query(strip, ['north-star'])).toEqual([{ running: 2 }]);
    expect(await db.query(strip, ['mission-control'])).toEqual([{ running: ours }]);
    expect(await db.query(strip, ['zero-laps'])).toEqual([{ running: 0 }]);

    // The seed already runs one second-factory lap, on claim.
    const lapping = ['mission-control', 'north-star', 'second-factory'];
    const lapsOf = new Map(
      await Promise.all(lapping.map(async (f) => [f, await lapsOnNodes(f)] as const)),
    );
    const on = (all: Row[], path: string) =>
      all
        .filter((r) => r.path === path)
        .map(({ lap_factory, laps, is_current }) => ({ lap_factory, laps, is_current }))
        .sort((a, b) => String(a.lap_factory).localeCompare(String(b.lap_factory)));
    expect(await rows('zero-laps')).toEqual([]);
    for (const address of lapping) {
      const all = await rows(address);
      expect(on(all, 'build')).toEqual([
        { lap_factory: 'mission-control', laps: 1, is_current: address === 'mission-control' },
        { lap_factory: 'north-star', laps: 1, is_current: address === 'north-star' },
      ]);
      expect(on(all, 'deploy')).toEqual([
        { lap_factory: 'north-star', laps: 1, is_current: address === 'north-star' },
      ]);
      for (const path of new Set(all.map((r) => r.path))) {
        if (path === null) continue;
        const expected = lapping
          .map((f) => ({
            lap_factory: f,
            laps: lapsOf.get(f)?.(path) ?? 0,
            is_current: f === address,
          }))
          .filter((e) => e.laps > 0);
        expect([path, on(all, path)]).toEqual([
          path,
          expected.length > 0 ? expected : [{ lap_factory: null, laps: 0, is_current: false }],
        ]);
      }
      const live = await liveCounts(address);
      for (const [path, count] of live) {
        if (path !== null) expect([path, count]).toEqual([path, lapsOf.get(address)?.(path) ?? 0]);
      }
    }
    await db.query(`DELETE FROM mc.lap_steps WHERE run_id::text LIKE '%0000000000c_'`);
    await db.query(`DELETE FROM mc.laps WHERE run_id::text LIKE '%0000000000c_'`);
  });

  test('step-detail reads V2, the current pin, whose subject names a short sha', async () => {
    const query = queries.find(([n]) => n === 'step-detail')?.[1] as string;
    const steps = await db.query(query, ['mission-control']);
    const ids = steps.filter((s) => s.workflow === 'archon-loop').map((s) => s.step_id);
    expect(ids).toContain('check-app');
    expect(ids).toContain('tally');
    expect(ids).not.toContain('briefs');
  });
});
