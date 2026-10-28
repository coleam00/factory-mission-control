import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { HomeMapRow } from '../../app/lib/home-map';
import { findStep, type NestingRow, type StepRow } from '../../app/lib/step-detail';
import type { Db } from '../../scripts/lib/db';
import { onTheSeed, queries } from './test-seed';

describe('home-map on the seed', () => {
  let db: Db;
  const sql = queries.find(([name]) => name === 'home-map')?.[1] as string;
  type Row = Pick<
    HomeMapRow,
    | 'role'
    | 'path'
    | 'parent_path'
    | 'step_id'
    | 'workflow'
    | 'position'
    | 'detail_workflow'
    | 'detail_path'
    | 'lap_factory'
    | 'laps'
    | 'is_current'
  >;
  const rows = async (factory = 'mission-control') => (await db.query(sql, [factory])) as Row[];
  /** A node's key: paths are unique only within a workflow. */
  const node = (path: string, workflow = 'archon-loop') => `${workflow} ${path}`;
  const pathOf = (key: string) => {
    const [workflow, path] = key.split(' ');
    return [path, workflow] as const;
  };
  /** The address factory's laps on each node: the `laps` of its `is_current` row, else 0. */
  const liveCounts = async (factory = 'mission-control') => {
    const counts = new Map<string, number>();
    for (const row of await rows(factory)) {
      if (row.path === null) continue;
      const key = node(row.path, row.workflow);
      counts.set(key, row.is_current ? row.laps : (counts.get(key) ?? 0));
    }
    return counts;
  };

  beforeAll(async () => {
    db = await onTheSeed();
  }, 60_000);
  afterAll(() => db.close());

  test("shows the newest pin's architecture: V3 stores none, so V2's loop with ship expanded", async () => {
    const all = await rows();
    const ordered = (role: string, parent: string | null = null) =>
      all
        .filter((r) => r.role === role && r.parent_path === parent)
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
    expect(ordered('stage', 'ship')).toEqual([
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
    const ship = all.filter((r) => r.parent_path === 'ship');
    expect(ship.map((r) => [r.detail_workflow, r.detail_path])).toEqual(
      ship.map((r) => ['archon-ship-block', r.step_id]),
    );
    expect(
      [
        ...new Set(
          all
            .filter((r) => r.role === 'input' || r.role === 'manager')
            .map((r) => `${r.role} ${r.workflow}`),
        ),
      ].sort(),
    ).toEqual(['input archon-backlog', 'input archon-holdouts', 'manager archon-manager']);

    // Every node of each shown workflow's expanded tree at V2, at every depth, once: no laps on it.
    const stored = (await db.query(
      `SELECT s.workflow, s.path FROM mc.arch_steps s
        WHERE s.workflow IN ('archon-loop', 'archon-manager', 'archon-holdouts', 'archon-backlog')
          AND (s.archon_sha, s.factory_sha) IN (SELECT archon_sha, factory_sha FROM mc.arch_steps
            WHERE workflow = 'archon-loop' AND path = 'tally')`,
    )) as { workflow: string; path: string }[];
    const shown = (workflow: string) =>
      [...new Set(all.filter((r) => r.workflow === workflow && r.path).map((r) => r.path))].sort();
    const inStore = (workflow: string) =>
      stored
        .filter((s) => s.workflow === workflow)
        .map((s) => s.path)
        .sort();
    for (const [workflow, count] of [
      ['archon-loop', 84],
      ['archon-backlog', 5],
      ['archon-holdouts', 2],
      ['archon-manager', 2],
    ] as const) {
      expect([workflow, shown(workflow).length]).toEqual([workflow, count]);
      expect(shown(workflow)).toEqual(inStore(workflow));
    }
    const opens = (path: string) => {
      const row = all.find((r) => r.workflow === 'archon-loop' && r.path === path);
      return [row?.detail_workflow, row?.detail_path];
    };
    expect(opens('ship/deliver/rounds/implement/implement')).toEqual([
      'archon-implement',
      'implement',
    ]);
    expect(opens('ship/deliver/rounds/review/code')).toEqual(['archon-review-block', 'code']);
    expect(opens('ship/deliver/rounds')).toEqual(['archon-deliver-block', 'rounds']);
    expect(opens('ship/forge')).toEqual(['archon-ship-block', 'forge']);
    expect(opens('check-app')).toEqual(['archon-loop', 'check-app']);
  });

  test("every node opens the screen step-nesting opens for it, and that screen's step exists", async () => {
    const query = (name: string) => queries.find(([n]) => n === name)?.[1] as string;
    const all = (await rows()).flatMap(({ path, detail_path, ...r }) =>
      path === null || detail_path === null ? [] : [{ ...r, path, detail_path }],
    );
    const screens = (await db.query(query('step-detail'), [
      'mission-control',
      '',
    ])) as unknown as StepRow[];
    const opens = new Map<string, string>();
    for (const top of all.filter((r) => r.parent_path === null)) {
      opens.set(node(top.path, top.workflow), `${top.workflow} / ${top.path}`);
      const inside = (await db.query(query('step-nesting'), [
        'mission-control',
        top.workflow,
        top.path,
        '',
      ])) as unknown as NestingRow[];
      for (const row of inside.filter((r) => r.relation === 'inside')) {
        opens.set(node(row.path, row.workflow), `${row.open_workflow} / ${row.open_path}`);
      }
    }
    expect(opens.size).toBe(93);
    expect(
      new Map(
        all.map((r) => [node(r.path, r.workflow), `${r.detail_workflow} / ${r.detail_path}`]),
      ),
    ).toEqual(opens);
    for (const row of all) {
      const key = node(row.path, row.workflow);
      expect([key, findStep(screens, row.detail_workflow, row.detail_path)?.path]).toEqual([
        key,
        row.detail_path,
      ]);
    }
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
      `SELECT l.workflow_name, ls.run_id, ls.step_id
        FROM mc.lap_steps ls JOIN mc.laps l USING (run_id)
        WHERE l.factory = $1 AND l.status = 'running' AND ls.status = 'running'`,
      [factory],
    )) as { workflow_name: string; run_id: string; step_id: string }[];
    return (path: string, workflow = 'archon-loop') => {
      const key = path.replaceAll('/', '__');
      const on = running.filter(
        (r) =>
          r.workflow_name === workflow && (r.step_id === key || r.step_id.startsWith(`${key}__`)),
      );
      return new Set(on.map((r) => r.run_id)).size;
    };
  };

  test("each step counts the factory's running laps on it now, as SQL over the seed does", async () => {
    const on = await lapsOnNodes('mission-control');
    expect([on('build'), on('check-app')]).toEqual([1, 1]);
    for (const [key, count] of await liveCounts()) {
      expect([key, count]).toEqual([key, on(...pathOf(key))]);
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
    expect(counts.get(node('ship/intel'))).toBe(1);
    expect(counts.get(node('ship'))).toBe(1);
    expect(counts.get(node('intel'))).toBeUndefined();
    const on = await lapsOnNodes('mission-control');
    for (const [key, count] of counts) expect([key, count]).toEqual([key, on(...pathOf(key))]);
    await db.query(
      `INSERT INTO remote_agent_workflow_events (workflow_run_id, event_type, step_name, data)
        VALUES ($1, 'node_completed', 'ship__intel', '{}'::jsonb)`,
      [lap.run_id],
    );
    expect((await liveCounts()).get(node('ship/intel'))).toBe(0);
  });

  test('a lap on a nested step counts on that step and on every box around it', async () => {
    const [lap] = await db.query(
      `SELECT l.run_id FROM mc.laps l JOIN mc.lap_steps ls USING (run_id)
        WHERE l.status = 'running' AND ls.step_id = 'check-app' AND ls.status = 'running'`,
    );
    const event = (type: string) =>
      db.query(
        `INSERT INTO remote_agent_workflow_events (workflow_run_id, event_type, step_name, data)
          VALUES ($1, $2, 'ship__deliver__rounds__implement__implement', '{}'::jsonb)`,
        [lap.run_id, type],
      );
    await event('node_started');
    const around = [
      'ship/deliver/rounds/implement/implement',
      'ship/deliver/rounds/implement',
      'ship/deliver/rounds',
      'ship/deliver',
      'ship',
    ];
    const counts = await liveCounts();
    expect(around.map((path) => counts.get(node(path)))).toEqual([1, 1, 1, 1, 1]);
    expect(counts.get(node('ship/deliver/rounds/reshape/implement'))).toBe(0);
    const on = await lapsOnNodes('mission-control');
    for (const [key, count] of counts) expect([key, count]).toEqual([key, on(...pathOf(key))]);
    await event('node_completed');
    const after = await liveCounts();
    expect(around.map((path) => after.get(node(path)))).toEqual([0, 0, 0, 0, 0]);
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
    expect((await liveCounts()).get(node('review'))).toBe(1);
    expect((await rows('second-factory')).filter((r) => r.path === 'review')).toEqual([
      expect.objectContaining({ lap_factory: 'mission-control', laps: 1, is_current: false }),
    ]);
    expect((await liveCounts('second-factory')).get(node('review'))).toBe(0);
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
    const on = (all: Row[], path: string, workflow = 'archon-loop') =>
      all
        .filter((r) => r.workflow === workflow && r.path === path)
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
      for (const key of new Set(
        all.flatMap((r) => (r.path === null ? [] : [node(r.path, r.workflow)])),
      )) {
        const [path, workflow] = pathOf(key);
        const expected = lapping
          .map((f) => ({
            lap_factory: f,
            laps: lapsOf.get(f)?.(path, workflow) ?? 0,
            is_current: f === address,
          }))
          .filter((e) => e.laps > 0);
        expect([key, on(all, path, workflow)]).toEqual([
          key,
          expected.length > 0 ? expected : [{ lap_factory: null, laps: 0, is_current: false }],
        ]);
      }
      const live = await liveCounts(address);
      for (const [key, count] of live) {
        expect([key, count]).toEqual([key, lapsOf.get(address)?.(...pathOf(key)) ?? 0]);
      }
    }
    await db.query(`DELETE FROM mc.lap_steps WHERE run_id::text LIKE '%0000000000c_'`);
    await db.query(`DELETE FROM mc.laps WHERE run_id::text LIKE '%0000000000c_'`);
  });

  test('step-detail reads V2, the current pin, whose subject names a short sha', async () => {
    const query = queries.find(([n]) => n === 'step-detail')?.[1] as string;
    const steps = await db.query(query, ['mission-control', '']);
    const ids = steps.filter((s) => s.workflow === 'archon-loop').map((s) => s.step_id);
    expect(ids).toContain('check-app');
    expect(ids).toContain('tally');
    expect(ids).not.toContain('briefs');
  });
});
