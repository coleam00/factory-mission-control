import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { seededDb } from '../scripts/fixture/seed';
import { REPO_ROOT } from '../scripts/lib/cli';
import type { Db } from '../scripts/lib/db';
import { runMigrations } from '../scripts/migrate';
import { LIVE_QUERY_NAME, loadLiveQueries } from '../server/live';
import { archonDb, migrationFiles } from './test-db';

const dir = join(import.meta.dir, 'queries');
const queries = [...loadLiveQueries(dir)];

/** Functions whose value changes between evaluations; Realtime refuses them (REALTIME.md). */
const VOLATILE =
  /\b(now|random|clock_timestamp|statement_timestamp|transaction_timestamp|timeofday|gen_random_uuid|nextval|current_timestamp|current_date|current_time|localtime|localtimestamp)\b/i;

test('every file in db/queries/ is a live query named for its panel', () => {
  const sqlFiles = readdirSync(dir).filter((f) => f.endsWith('.sql'));
  expect(sqlFiles.length).toBeGreaterThan(0);
  for (const file of sqlFiles) expect(file.slice(0, -4)).toMatch(LIVE_QUERY_NAME);
});

describe.each(queries)('db/queries/%s.sql', (_name, sql) => {
  test('is one read-only SELECT', () => {
    expect(sql).not.toContain(';');
    expect(sql).toMatch(/^(SELECT|WITH)\b/i);
    expect(sql).not.toMatch(/\b(insert|update|delete|merge|truncate|for\s+update|for\s+share)\b/i);
  });

  test('uses no volatile function', () => {
    expect(sql).not.toMatch(VOLATILE);
  });

  test("reads the dashboard's own tables, never Archon's", () => {
    expect(sql).not.toMatch(/remote_agent_|provider_event/i);
  });

  test('is keyed by one factory, $1, and takes no other parameter', () => {
    expect(sql).toMatch(/\$1\b/);
    expect(sql).not.toMatch(/\$([2-9]|\d{2,})/);
  });
});

describe('against the migrated schema', () => {
  let db: Db;

  beforeAll(async () => {
    db = await archonDb();
    await runMigrations({ files: migrationFiles, db });
  });

  afterAll(() => db.close());

  test.each(queries)('%s runs with a factory name as $1', async (_name, sql) => {
    await db.query(sql, ['mission-control']);
  });

  test('status-strip counts one factory’s running laps and nothing else', async () => {
    await db.query(`INSERT INTO mc.laps (run_id, factory, workflow_name, status) VALUES
      ('00000000-0000-0000-0000-0000000000a1', 'mission-control', 'archon-loop', 'running'),
      ('00000000-0000-0000-0000-0000000000a2', 'mission-control', 'archon-loop', 'running'),
      ('00000000-0000-0000-0000-0000000000a3', 'mission-control', 'archon-loop', 'completed'),
      ('00000000-0000-0000-0000-0000000000a5', 'mission-control', 'archon-manager', 'running'),
      ('00000000-0000-0000-0000-0000000000a4', 'other', 'archon-loop', 'running')`);
    const sql = queries.find(([name]) => name === 'status-strip')?.[1] as string;
    expect(await db.query(sql, ['mission-control'])).toEqual([{ running: 2 }]);
    expect(await db.query(sql, ['other'])).toEqual([{ running: 1 }]);
  });
});

describe('home-map on the seed', () => {
  let db: Db;
  const sql = queries.find(([name]) => name === 'home-map')?.[1] as string;
  const rows = async () =>
    (await db.query(sql, ['mission-control'])) as {
      role: string;
      path: string | null;
      step_id: string | null;
      workflow: string;
      position: number | null;
      detail_workflow: string;
      live_count: number;
    }[];

  beforeAll(async () => {
    db = await seededDb(REPO_ROOT, readFileSync(join(REPO_ROOT, 'fixtures', 'seed.sql'), 'utf8'));
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
    for (const row of await rows()) {
      if (row.path !== null) expect(row.live_count).toBe(on(row.path));
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
    const counts = new Map((await rows()).map((r) => [r.path, r.live_count]));
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
    expect((await rows()).find((r) => r.path === 'ship/intel')?.live_count).toBe(0);
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
    const review = (await rows()).find((r) => r.step_id === 'review');
    expect(review?.live_count).toBe(1);
    expect(await db.query(sql, ['other'])).toEqual(
      expect.arrayContaining([expect.objectContaining({ step_id: 'review', live_count: 0 })]),
    );
  });
});
