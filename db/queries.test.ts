import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type ArchDiffRow,
  diffVersions,
  type Item,
  itemLabel,
  KINDS,
  type Kind,
} from '../app/lib/arch-diff';
import type { HomeMapRow } from '../app/lib/home-map';
import { OUTCOMES } from '../app/lib/laps';
import {
  dataValue,
  type MeasureKey,
  type ScorecardRow,
  scorecard,
  versionLaps,
  versionPin,
} from '../app/lib/scorecard';
import { findStep, joinParts, type NestingRow, type StepRow } from '../app/lib/step-detail';
import { SEED_CODEBASE, seededDb } from '../scripts/fixture/seed';
import { seedLaps } from '../scripts/fixture/seed-laps';
import { eventData, writeRow } from '../scripts/fixture/write';
import { REPO_ROOT } from '../scripts/lib/cli';
import type { Db, Row } from '../scripts/lib/db';
import { runMigrations } from '../scripts/migrate';
import { LIVE_QUERY_NAME, loadLiveQueries, parameterCount } from '../server/live';
import { archonDb, migrationFiles } from './test-db';

const dir = join(import.meta.dir, 'queries');
const queries = [...loadLiveQueries(dir)];

/** The step screen's panels below step-detail: keyed by the step's workflow and path too. */
const STEP_PANELS = [
  'step-nesting',
  'step-prompt',
  'step-subagents',
  'step-scripts',
  'step-hooks',
  'step-yaml',
];
const CHECK_APP = ['archon-loop', 'check-app'];
/** The one-lap screen's panels: keyed by the lap's run id too. */
const LAP_PANELS = ['one-lap', 'one-lap-steps', 'one-lap-checks'];
const LAP_RUN = '5eed0001-0000-4000-8000-000000000003';
const paramsFor = (name: string, factory: string) =>
  STEP_PANELS.includes(name)
    ? [factory, ...CHECK_APP]
    : LAP_PANELS.includes(name)
      ? [factory, LAP_RUN]
      : [factory];

/** Functions whose value changes between evaluations; Realtime refuses them (REALTIME.md). */
const VOLATILE =
  /\b(now|random|clock_timestamp|statement_timestamp|transaction_timestamp|timeofday|gen_random_uuid|nextval|current_timestamp|current_date|current_time|localtime|localtimestamp)\b/i;

test('every file in db/queries/ is a live query named for its panel', () => {
  const sqlFiles = readdirSync(dir).filter((f) => f.endsWith('.sql'));
  expect(sqlFiles.length).toBeGreaterThan(0);
  for (const file of sqlFiles) expect(file.slice(0, -4)).toMatch(LIVE_QUERY_NAME);
});

describe.each(queries)('db/queries/%s.sql', (name, sql) => {
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

  test("is keyed by one factory, $1, a step panel's by the step's workflow and path, a lap's by its run id", () => {
    expect(sql).toMatch(/\$1\b/);
    expect(parameterCount(sql)).toBe(paramsFor(name, '').length);
  });
});

describe('against the migrated schema', () => {
  let db: Db;

  beforeAll(async () => {
    db = await archonDb();
    await runMigrations({ files: migrationFiles, db });
  });

  afterAll(() => db.close());

  test.each(queries)('%s runs with a factory name as $1', async (name, sql) => {
    await db.query(sql, paramsFor(name, 'mission-control'));
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

  test('factory-switcher lists every factory with its own running laps, $1 as the default', async () => {
    await db.query(`INSERT INTO mc.factories (name, repository, codebase, console) VALUES
      ('switch-a', 'o/a', 'o/a', 'http://localhost:3090'),
      ('switch-b', 'o/b', 'o/b', 'http://localhost:3090'),
      ('switch-c', 'o/c', 'o/c', 'http://localhost:3090')`);
    await db.query(`INSERT INTO mc.laps (run_id, factory, workflow_name, status) VALUES
      ('00000000-0000-0000-0000-0000000000b1', 'switch-a', 'archon-loop', 'running'),
      ('00000000-0000-0000-0000-0000000000b2', 'switch-a', 'archon-loop', 'completed'),
      ('00000000-0000-0000-0000-0000000000b3', 'switch-a', 'archon-manager', 'running'),
      ('00000000-0000-0000-0000-0000000000b4', 'switch-b', 'archon-loop', 'running'),
      ('00000000-0000-0000-0000-0000000000b5', 'switch-b', 'archon-loop', 'running')`);
    const sql = queries.find(([name]) => name === 'factory-switcher')?.[1] as string;
    const rows = await db.query(`SELECT * FROM (${sql}) s ORDER BY factory`, ['switch-a']);
    expect(rows).toEqual([
      { factory: 'switch-a', running: 1, is_default: true },
      { factory: 'switch-b', running: 2, is_default: false },
      { factory: 'switch-c', running: 0, is_default: false },
    ]);
    await db.query(`DELETE FROM mc.laps WHERE run_id::text LIKE '%0000000000b_'`);
    await db.query(`DELETE FROM mc.factories WHERE name LIKE 'switch-%'`);
  });

  test('step queries read the newest pin with architecture rows, for a factory the dashboard shows', async () => {
    const sql = (name: string) => queries.find(([n]) => n === name)?.[1] as string;
    // A long multi-byte file: each part must stay under the 16 KiB Realtime answers (REALTIME.md).
    const long = `${'é'.repeat(4500)}
${'x'.repeat(5000)}`;
    await db.query(`INSERT INTO mc.factories (name, repository, codebase, console)
      VALUES ('mission-control', 'o/r', 'o/r', 'http://localhost:3090')`);
    await db.query(`INSERT INTO mc.pins (sha, archon_sha, reason, committed_at) VALUES
      ('p1', 'a1', 'one', '2026-01-01T00:00:00Z'),
      ('p2', 'a2', 'two', '2026-02-01T00:00:00Z'),
      ('p3', 'a3', 'three, not parsed yet', '2026-03-01T00:00:00Z')`);
    await db.query(`INSERT INTO mc.arch_versions (archon_sha, factory_sha, parsed_at) VALUES
      ('a1', 'f', '2026-01-02T00:00:00Z'), ('a2', 'f', '2026-02-02T00:00:00Z')`);
    // Both versions share every name and path, so a query that leaks a1 doubles or mixes rows.
    for (const [sha, deps] of [
      ['a1', '{subject,briefs}'],
      ['a2', '{subject}'],
    ]) {
      await db.query(
        `INSERT INTO mc.arch_steps (archon_sha, factory_sha, workflow, path, position, step_id, kind,
           depends_on, command_file, script_file, defined_in, file)
         VALUES ($1, 'f', 'archon-loop', 'check-app', 0, 'check-app', 'command', $2,
           'loop/commands/loop-check-app.md', 'loop/scripts/check.ts', 'archon-loop',
           'loop/archon-loop.yaml')`,
        [sha, deps],
      );
      await db.query(
        `INSERT INTO mc.arch_texts (archon_sha, factory_sha, path, text) VALUES
           ($1, 'f', 'loop/commands/loop-check-app.md', $2),
           ($1, 'f', 'loop/agents/verifier.md', $2)`,
        [sha, `${sha} ${long}`],
      );
      await db.query(
        `INSERT INTO mc.arch_subagents (archon_sha, factory_sha, workflow, step_path, name,
           description, instruction_file)
         VALUES ($1, 'f', 'archon-loop', 'check-app', 'verifier', $1, 'loop/agents/verifier.md')`,
        [sha],
      );
      await db.query(
        `INSERT INTO mc.arch_scripts (archon_sha, factory_sha, path, text)
         VALUES ($1, 'f', 'loop/scripts/check.ts', $2)`,
        [sha, `${sha} ${long}`],
      );
      await db.query(
        `INSERT INTO mc.arch_hooks (archon_sha, factory_sha, path, text, admitted_agents)
         VALUES ($1, 'f', 'hooks/fence.py', $1, '{verifier}')`,
        [sha],
      );
      await db.query(
        `INSERT INTO mc.arch_workflows (archon_sha, factory_sha, name, file, yaml)
         VALUES ($1, 'f', 'archon-loop', 'loop/archon-loop.yaml', $2)`,
        [sha, `${sha} ${long}`],
      );
    }

    for (const [name, query] of queries.filter(([n]) => n.startsWith('step-'))) {
      expect([name, await db.query(query, paramsFor(name, 'other'))]).toEqual([name, []]);
    }
    for (const name of STEP_PANELS) {
      const otherStep = await db.query(sql(name), ['mission-control', 'archon-loop', 'subject']);
      expect([name, otherStep]).toEqual([name, []]);
    }
    const steps = await db.query(sql('step-detail'), ['mission-control']);
    expect(steps.map((s) => s.depends_on)).toEqual([['subject']]);

    // A second workflow with a step at the same path and files of its own: a step panel that
    // ignores the workflow ($2) shows them on archon-loop's step too.
    await db.query(
      `INSERT INTO mc.arch_steps (archon_sha, factory_sha, workflow, path, position, step_id, kind,
         depends_on, command_file, script_file, defined_in, file)
       VALUES ('a2', 'f', 'archon-manager', 'check-app', 0, 'check-app', 'command', '{}',
         'manager/commands/check.md', 'manager/scripts/check.ts', 'archon-manager',
         'manager/archon-manager.yaml')`,
    );
    await db.query(`INSERT INTO mc.arch_texts (archon_sha, factory_sha, path, text) VALUES
      ('a2', 'f', 'manager/commands/check.md', 'manager prompt'),
      ('a2', 'f', 'manager/agents/judge.md', 'manager judge file')`);
    await db.query(`INSERT INTO mc.arch_subagents (archon_sha, factory_sha, workflow, step_path,
        name, description, instruction_file)
      VALUES ('a2', 'f', 'archon-manager', 'check-app', 'judge', 'manager judge',
        'manager/agents/judge.md')`);
    await db.query(`INSERT INTO mc.arch_scripts (archon_sha, factory_sha, path, text)
      VALUES ('a2', 'f', 'manager/scripts/check.ts', 'manager script')`);
    await db.query(`INSERT INTO mc.arch_hooks (archon_sha, factory_sha, path, text, admitted_agents)
      VALUES ('a2', 'f', 'hooks/judge.py', 'manager hook', '{judge}')`);
    await db.query(`INSERT INTO mc.arch_workflows (archon_sha, factory_sha, name, file, yaml)
      VALUES ('a2', 'f', 'archon-manager', 'manager/archon-manager.yaml', 'manager yaml')`);
    const manager = (name: string) =>
      db.query(sql(name), ['mission-control', 'archon-manager', 'check-app']);
    expect(await manager('step-prompt')).toEqual([
      { path: 'manager/commands/check.md', part: 0, chunk: 'manager prompt' },
    ]);
    expect(await manager('step-subagents')).toEqual([
      {
        workflow: 'archon-manager',
        step_path: 'check-app',
        name: 'judge',
        description: 'manager judge',
        prompt: null,
        instruction_file: 'manager/agents/judge.md',
        part: 0,
        chunk: 'manager judge file',
      },
    ]);
    expect(await manager('step-scripts')).toEqual([
      { path: 'manager/scripts/check.ts', part: 0, chunk: 'manager script' },
    ]);
    expect(await manager('step-hooks')).toEqual([
      {
        path: 'hooks/judge.py',
        admitted_agents: ['judge'],
        workflow: 'archon-manager',
        step_path: 'check-app',
        agent: 'judge',
        description: 'manager judge',
      },
    ]);
    expect(await manager('step-yaml')).toEqual([
      {
        name: 'archon-manager',
        file: 'manager/archon-manager.yaml',
        part: 0,
        chunk: 'manager yaml',
      },
    ]);

    const files = async (name: string, key: (row: Record<string, unknown>) => unknown) => {
      const parts = (await db.query(sql(name), paramsFor(name, 'mission-control'))) as {
        part: number;
        chunk: string;
      }[];
      expect(parts.length).toBe(3);
      for (const { chunk } of parts) expect(Buffer.byteLength(chunk)).toBeLessThan(16 * 1024);
      return joinParts(parts, (row) => String(key(row)));
    };
    expect(await files('step-prompt', (row) => row.path)).toEqual(
      new Map([['loop/commands/loop-check-app.md', `a2 ${long}`]]),
    );
    expect(await files('step-subagents', (row) => `${row.name} ${row.description}`)).toEqual(
      new Map([['verifier a2', `a2 ${long}`]]),
    );
    expect(await files('step-scripts', (row) => row.path)).toEqual(
      new Map([['loop/scripts/check.ts', `a2 ${long}`]]),
    );
    expect(await files('step-yaml', (row) => row.name)).toEqual(
      new Map([['archon-loop', `a2 ${long}`]]),
    );
    expect(await db.query(sql('step-hooks'), paramsFor('step-hooks', 'mission-control'))).toEqual([
      {
        path: 'hooks/fence.py',
        admitted_agents: ['verifier'],
        workflow: 'archon-loop',
        step_path: 'check-app',
        agent: 'verifier',
        description: 'a2',
      },
    ]);
  });
});

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

describe('step screens of included blocks on the seed', () => {
  let db: Db;
  const sql = (name: string) => queries.find(([n]) => n === name)?.[1] as string;
  const nestingOf = async (workflow: string, path: string) =>
    (await db.query(sql('step-nesting'), [
      'mission-control',
      workflow,
      path,
    ])) as unknown as NestingRow[];
  const opens = (row: NestingRow) => `${row.open_workflow} / ${row.open_path}`;

  beforeAll(async () => {
    db = await seededDb(REPO_ROOT, readFileSync(join(REPO_ROOT, 'fixtures', 'seed.sql'), 'utf8'));
  }, 60_000);
  afterAll(() => db.close());

  test("the step that writes the code has its own screen and prompt, and no alias under deliver's block", async () => {
    const steps = (await db.query(sql('step-detail'), ['mission-control'])) as unknown as StepRow[];
    expect(findStep(steps, 'archon-implement', 'implement')?.command_file).toBe(
      'implement/commands/implement.md',
    );
    expect(findStep(steps, 'archon-deliver-block', 'implement')).toBeUndefined();
    const parts = (await db.query(sql('step-prompt'), [
      'mission-control',
      'archon-implement',
      'implement',
    ])) as { path: string; part: number; chunk: string }[];
    expect(joinParts(parts, (row) => row.path).get('implement/commands/implement.md')).toBe(
      readFileSync(
        join(REPO_ROOT, 'fixtures', 'pack', 'sdlc', 'implement', 'commands', 'implement.md'),
        'utf8',
      ),
    );
  });

  test("deliver's screen lists both occurrences of implement, each opening its own screen", async () => {
    const inside = new Map(
      (await nestingOf('archon-ship-block', 'deliver'))
        .filter((row) => row.relation === 'inside')
        .map((row) => [row.path, opens(row)]),
    );
    expect(inside.get('deliver/rounds/implement')).toBe('archon-deliver-block / rounds/implement');
    expect(inside.get('deliver/rounds/implement/implement')).toBe('archon-implement / implement');
    expect(inside.get('deliver/rounds/reshape/implement')).toBe('archon-implement / implement');
  });

  test('every step beneath ship opens a screen that exists', async () => {
    const steps = (await db.query(sql('step-detail'), ['mission-control'])) as unknown as StepRow[];
    const inside = (await nestingOf('archon-loop', 'ship')).filter((r) => r.relation === 'inside');
    expect(inside.length).toBeGreaterThan(50);
    const missing = inside.filter((row) => !findStep(steps, row.open_workflow, row.open_path));
    expect(missing.map((row) => row.path)).toEqual([]);
  });

  test("implement's screen lists every place an include puts it, opening the node it sits in", async () => {
    const places = (await nestingOf('archon-implement', 'implement'))
      .filter((row) => row.relation === 'included_at')
      .map((row) => `${row.workflow} ${row.path} -> ${opens(row)}`)
      .sort();
    expect(places).toEqual([
      'archon-deliver-block rounds/implement/implement -> archon-deliver-block / rounds/implement',
      'archon-deliver-block rounds/reshape/implement -> archon-deliver-block / rounds/reshape',
      'archon-loop ship/deliver/rounds/implement/implement -> archon-deliver-block / rounds/implement',
      'archon-loop ship/deliver/rounds/reshape/implement -> archon-deliver-block / rounds/reshape',
      'archon-ship-block deliver/rounds/implement/implement -> archon-deliver-block / rounds/implement',
      'archon-ship-block deliver/rounds/reshape/implement -> archon-deliver-block / rounds/reshape',
    ]);
  });
});

describe('version-strip on the seed', () => {
  let db: Db;
  const sql = queries.find(([name]) => name === 'version-strip')?.[1] as string;
  const strip = () => db.query(sql, ['mission-control']);

  beforeAll(async () => {
    db = await seededDb(REPO_ROOT, readFileSync(join(REPO_ROOT, 'fixtures', 'seed.sql'), 'utf8'));
  }, 60_000);

  afterAll(() => db.close());

  test('is one row per seeded version, labelled by the pin committed before its first run', async () => {
    const rows = (await strip()).sort(
      (a, b) =>
        Number(new Date(a.first_run_at as string)) - Number(new Date(b.first_run_at as string)),
    );
    const versions = await db.query(
      'SELECT digest, pin_sha FROM mc.versions WHERE factory = $1 ORDER BY first_run_at',
      ['mission-control'],
    );
    const pins = await db.query('SELECT sha FROM mc.pins ORDER BY committed_at');
    expect(rows.map(({ digest, pin_sha }) => ({ digest, pin_sha }))).toEqual(
      versions.map(({ digest, pin_sha }) => ({ digest, pin_sha })),
    );
    expect(rows.map((r) => r.pin_sha)).toEqual(pins.map((p) => p.sha));
    expect(rows[2]).toMatchObject({ hypothesis: null, measure: null });
  });

  test('each pin written after the last run adds one entry that has not run yet', async () => {
    await db.transaction(async (tx) => {
      await writeRow(tx, 'pin', new Date('2026-10-25T12:00:00Z'));
    });
    const [pin] = await db.query('SELECT sha FROM mc.pins ORDER BY committed_at DESC LIMIT 1');
    const rows = await strip();
    expect(rows).toHaveLength(4);
    expect(rows.filter((r) => r.digest === null).map((r) => r.pin_sha)).toEqual([pin.sha]);

    await db.transaction(async (tx) => {
      await writeRow(tx, 'pin', new Date('2026-10-25T12:03:00Z'));
    });
    expect(await strip()).toHaveLength(5);
  });

  test('pins are shared: a factory with a lap is labelled by them and lists the unused ones, a factory with none lists nothing', async () => {
    const rollback = new Error('rollback');
    await db
      .transaction(async (tx) => {
        await writeRow(tx, 'pin', new Date('2026-10-25T13:00:00Z'));
        const unused = (await tx.query(sql, ['mission-control']))
          .filter((r) => r.digest === null)
          .map((r) => r.pin_sha)
          .sort();
        expect(unused.length).toBeGreaterThan(0);
        expect(await tx.query(sql, ['empty-check'])).toEqual([]);

        await tx.query(`INSERT INTO mc.laps (run_id, factory, workflow_name, status, digest, started_at)
          VALUES ('00000000-0000-0000-0000-0000000000c1', 'north-star', 'archon-loop', 'completed',
            'north-star-digest', '2026-10-20T00:00:00Z')`);
        await tx.query(`INSERT INTO mc.factories (name, repository, codebase, console)
          VALUES ('north-star', 'coleam00/north-star', 'coleam00/north-star', 'http://localhost:3090')`);
        await tx.query(`SELECT mc.project_version('north-star', 'north-star-digest')`);
        const [label] = await tx.query(
          'SELECT sha FROM mc.pins WHERE committed_at < $1 ORDER BY committed_at DESC LIMIT 1',
          ['2026-10-20T00:00:00Z'],
        );
        const rows = await tx.query(sql, ['north-star']);
        expect(rows.filter((r) => r.digest !== null)).toMatchObject([
          { digest: 'north-star-digest', pin_sha: label.sha },
        ]);
        expect(
          rows
            .filter((r) => r.digest === null)
            .map((r) => r.pin_sha)
            .sort(),
        ).toEqual(unused);
        throw rollback;
      })
      .catch((error) => {
        if (error !== rollback) throw error;
      });
  });

  test('a digest only a non-archon-loop run used is not a version and uses up no pin', async () => {
    const rollback = new Error('rollback');
    const digest = 'sha256:fence-proof';
    await db
      .transaction(async (tx) => {
        await writeRow(tx, 'pin', new Date('2026-10-25T14:00:00Z'));
        const [pin] = await tx.query('SELECT sha FROM mc.pins ORDER BY committed_at DESC LIMIT 1');
        await tx.query(
          `INSERT INTO remote_agent_workflow_runs (id, workflow_name, codebase_id, status,
            user_message, metadata, started_at, completed_at, last_activity_at)
          VALUES ('00000000-0000-4000-8000-0000000000f1', 'fence-proof', $1, 'completed', 'Prove the fence',
            $2::jsonb, '2026-10-25T15:00:00Z', '2026-10-25T15:10:00Z', '2026-10-25T15:10:00Z')`,
          [SEED_CODEBASE, JSON.stringify({ workflow_source: { digest } })],
        );
        expect(await tx.query('SELECT factory FROM mc.laps WHERE digest = $1', [digest])).toEqual([
          { factory: 'mission-control' },
        ]);
        expect(await tx.query('SELECT 1 FROM mc.versions WHERE digest = $1', [digest])).toEqual([]);

        const rows = await tx.query(sql, ['mission-control']);
        expect(rows.filter((r) => r.digest === digest)).toEqual([]);
        expect(rows.filter((r) => r.digest === null).map((r) => r.pin_sha)).toContain(pin.sha);
        const scorecardSql = queries.find(([name]) => name === 'scorecard')?.[1] as string;
        const card = await tx.query(scorecardSql, ['mission-control']);
        expect(card.filter((r) => r.digest === digest)).toEqual([]);
        throw rollback;
      })
      .catch((error) => {
        if (error !== rollback) throw error;
      });
  });

  test('a factory whose only runs are non-archon-loop runs lists nothing', async () => {
    const rollback = new Error('rollback');
    await db
      .transaction(async (tx) => {
        await tx.query(`INSERT INTO mc.laps (run_id, factory, workflow_name, status, digest, started_at)
          VALUES ('00000000-0000-0000-0000-0000000000c2', 'fence-only', 'fence-proof', 'completed',
            'sha256:fence-only', '2026-10-25T16:00:00Z')`);
        expect(await tx.query(sql, ['fence-only'])).toEqual([]);
        throw rollback;
      })
      .catch((error) => {
        if (error !== rollback) throw error;
      });
  });

  test('a recorded version no lap qualifies for is still listed, as a version', async () => {
    const rollback = new Error('rollback');
    await db
      .transaction(async (tx) => {
        const [pin] = await tx.query('SELECT sha FROM mc.pins ORDER BY committed_at LIMIT 1');
        await tx.query(
          `INSERT INTO mc.versions (factory, digest, first_run_at, pin_sha)
          VALUES ('mission-control', 'sha256:recorded-only', '2026-10-22T00:00:00Z', $1)`,
          [pin.sha],
        );
        const rows = await tx.query(sql, ['mission-control']);
        expect(rows.filter((r) => r.digest === 'sha256:recorded-only')).toMatchObject([
          { pin_sha: pin.sha },
        ]);
        throw rollback;
      })
      .catch((error) => {
        if (error !== rollback) throw error;
      });
  });
});

describe('scorecard on the seed', () => {
  let db: Db;
  const sql = queries.find(([name]) => name === 'scorecard')?.[1] as string;
  const expected = JSON.parse(
    readFileSync(join(REPO_ROOT, 'fixtures', 'expected-scorecard.json'), 'utf8'),
  ) as {
    versions: { digest: string; measures: Record<string, { value: number; laps: number }> }[];
  };

  beforeAll(async () => {
    db = await seededDb(REPO_ROOT, readFileSync(join(REPO_ROOT, 'fixtures', 'seed.sql'), 'utf8'));
  }, 60_000);

  afterAll(() => db.close());

  test('every measure of every seed version equals fixtures/expected-scorecard.json', async () => {
    const rows = (await db.query(sql, ['mission-control'])) as unknown as ScorecardRow[];
    expect(expected.versions).toHaveLength(3);
    for (const { digest, measures } of expected.versions) {
      const card = scorecard(versionLaps(rows, digest));
      const shown = Object.fromEntries(
        Object.keys(measures).map((key) => {
          const { value, laps } = card[key as MeasureKey];
          const data = dataValue(value);
          return [key, { value: data === 'n/a' ? null : Number(data), laps: laps.length }];
        }),
      );
      expect({ digest, measures: shown }).toEqual({ digest, measures });
    }
  });

  test.each([
    ['share one start time', (at: string) => ({ timing: { startedAt: at } })],
    ['carry no start time', () => ({})],
  ])(
    'a lap whose review sent back once and then merged counts every run when its runs %s',
    async (_, timing) => {
      const digest = 'sha256:repeated-review';
      const rollback = new Error('rollback');
      await db
        .transaction(async (tx) => {
          const [run] = await tx.query(
            `INSERT INTO remote_agent_workflow_runs (workflow_name, codebase_id, status, user_message,
             metadata, started_at, completed_at)
           VALUES ('archon-loop', $1, 'completed', 'Run the loop', $2, '2026-10-25T10:00:00Z',
             '2026-10-25T11:00:00Z') RETURNING id`,
            [SEED_CODEBASE, JSON.stringify({ workflow_source: { digest } })],
          );
          const finished = (step: string, at: string, data: object) =>
            tx.query(
              `INSERT INTO remote_agent_workflow_events (workflow_run_id, event_type, step_name, data,
               created_at) VALUES ($1, 'node_completed', $2, $3, $4)`,
              [run?.id, step, JSON.stringify({ ...timing('2026-10-25T10:05:00Z'), ...data }), at],
            );
          const checkApp = { duration_ms: 600_000, cost_usd: 0.5, structured_output: {} };
          const review = (outcome: string) => ({ cost_usd: 0.25, structured_output: { outcome } });
          await finished('pick', '2026-10-25T10:05:00Z', {
            cost_usd: 0.5,
            structured_output: { route: 'complex' },
          });
          await finished('check-app', '2026-10-25T10:15:00Z', checkApp);
          await finished('review', '2026-10-25T10:20:00Z', review('sent-back'));
          await finished('check-app', '2026-10-25T10:40:00Z', checkApp);
          await finished('review', '2026-10-25T10:45:00Z', review('merge'));
          await finished('land', '2026-10-25T10:50:00Z', {
            structured_output: { outcome: 'merged' },
          });

          const rows = (await tx.query(sql, ['mission-control'])) as unknown as ScorecardRow[];
          const card = scorecard(versionLaps(rows, digest));
          expect({
            send_backs: card.send_backs.value,
            cost_per_merge: card.cost_per_merge.value,
            app_check_share: card.app_check_share.value,
          }).toEqual({ send_backs: 1, cost_per_merge: 2, app_check_share: 0.3333 });
          throw rollback;
        })
        .catch((error) => {
          if (error !== rollback) throw error;
        });
    },
  );

  test('names each seed version by the pin the version strip names it by', async () => {
    const rows = (await db.query(sql, ['mission-control'])) as unknown as ScorecardRow[];
    const strip = queries.find(([name]) => name === 'version-strip')?.[1] as string;
    const versions = (await db.query(strip, ['mission-control'])).filter((r) => r.digest !== null);
    expect(versions).toHaveLength(3);
    for (const { digest, pin_sha, first_run_at } of versions) {
      expect(versionPin(rows, String(digest))).toEqual({
        firstRunAt: new Date(first_run_at as string),
        pin: pin_sha as string,
      });
    }
  });
});

describe('decisions-timeline and improvements-ledger on the seed', () => {
  let db: Db;
  const named = (name: string) => queries.find(([n]) => n === name)?.[1] as string;
  const timeline = () => db.query(named('decisions-timeline'), ['mission-control']);
  const ledgerRows = () => db.query(named('improvements-ledger'), ['mission-control']);
  const byPin = async (prefix: string) =>
    (await ledgerRows()).find((r) => String(r.pin_sha).startsWith(prefix));

  beforeAll(async () => {
    db = await seededDb(REPO_ROOT, readFileSync(join(REPO_ROOT, 'fixtures', 'seed.sql'), 'utf8'));
  }, 60_000);

  afterAll(() => db.close());

  test('the timeline is every decision, each joined to its pin and that pin’s version by prefix', async () => {
    const versions = await db.query('SELECT digest, pin_sha FROM mc.versions WHERE factory = $1', [
      'mission-control',
    ]);
    const decisions = await db.query('SELECT date::text AS date, title, version FROM mc.decisions');
    const rows = await timeline();
    expect(rows.map((r) => r.title).sort()).toEqual(decisions.map((d) => d.title).sort());
    const joined = rows.filter((r) => r.pin_sha !== null);
    expect(joined).toHaveLength(2);
    for (const row of joined) {
      expect(String(row.pin_sha)).toStartWith(String(row.version));
      expect(versions).toContainEqual({ digest: row.digest, pin_sha: row.pin_sha });
    }
  });

  test('a pin’s laps are this factory’s archon-loop laps of the versions it labels', async () => {
    const counted = await db.query(
      `SELECT v.pin_sha, count(*)::int AS laps FROM mc.laps l
       JOIN mc.versions v ON v.factory = l.factory AND v.digest = l.digest
       WHERE l.factory = $1 AND l.workflow_name = 'archon-loop' GROUP BY v.pin_sha`,
      ['mission-control'],
    );
    const rows = await ledgerRows();
    for (const { pin_sha, laps } of counted) {
      expect(rows.find((r) => r.pin_sha === pin_sha)?.laps).toBe(laps);
    }
    expect(await byPin('8e3e1cef')).toMatchObject({ verdict: 'helped' });
    expect(await byPin('5ffd60c6')).toMatchObject({ verdict: null });
  });

  test('a verdict on V2 by prefix gives V2 that verdict', async () => {
    await db.transaction(async (tx) => {
      await writeRow(tx, 'verdict', new Date('2026-10-25T12:00:00Z'), '5ffd60c6');
    });
    expect(await byPin('5ffd60c6')).toMatchObject({ verdict: 'inconclusive' });
    expect(await byPin('58c5f774')).toMatchObject({ verdict: null });
  });
});

describe('issue-graph on the seed', () => {
  let db: Db;
  const sql = queries.find(([name]) => name === 'issue-graph')?.[1] as string;
  const graph = () => db.query(sql, ['mission-control']);
  const states = async () =>
    Object.fromEntries(
      (await graph()).filter((r) => r.kind === 'issue').map((r) => [r.number, r.state]),
    );

  beforeAll(async () => {
    db = await seededDb(REPO_ROOT, readFileSync(join(REPO_ROOT, 'fixtures', 'seed.sql'), 'utf8'));
  }, 60_000);

  afterAll(() => db.close());

  test('is every seeded issue in its one state, and every Depends on line as an edge', async () => {
    expect(await states()).toEqual({
      1: 'merged',
      2: 'merged',
      3: 'merged',
      4: 'closed',
      5: 'merged',
      6: 'merged',
      7: 'merged',
      8: 'merged',
      9: 'pr-open',
      10: 'merged',
      11: 'claimed',
      12: 'pr-open',
      13: 'needs-owner',
      14: 'waiting',
      15: 'waiting',
      16: 'claimed',
      17: 'waiting',
      18: 'waiting',
    });
    const edges = (await graph())
      .filter((r) => r.kind === 'edge')
      .map((r) => [r.number, r.depends_on])
      .sort(([a, b], [c, d]) => Number(a) - Number(c) || Number(b) - Number(d));
    const seeded = await db.query(
      'SELECT issue_number, depends_on FROM mc.issue_dependencies WHERE factory = $1 ORDER BY 1, 2',
      ['mission-control'],
    );
    expect(edges).toEqual(seeded.map((r) => [r.issue_number, r.depends_on]));
  });

  test('a needs-owner label from fixture:write turns a waiting issue needs-owner', async () => {
    await db.transaction(async (tx) => {
      await writeRow(tx, 'label', new Date('2026-10-25T12:00:00Z'));
    });
    expect((await states())[18]).toBe('needs-owner');
  });

  test('another factory sees none of these issues', async () => {
    expect(await db.query(sql, ['other'])).toEqual([]);
  });
});

/** The architecture a version ran: the latest pin committed before its first lap, as parsed. */
async function archOf(db: Db, digest: string): Promise<Record<string, unknown>> {
  const [version] = await db.query(
    `SELECT a.archon_sha, a.factory_sha FROM mc.arch_versions a
     WHERE a.archon_sha = (
       SELECT p.archon_sha FROM mc.pins p
       WHERE p.committed_at < (SELECT min(started_at) FROM mc.laps WHERE digest = $1)
       ORDER BY p.committed_at DESC LIMIT 1)
     ORDER BY a.parsed_at DESC LIMIT 1`,
    [digest],
  );
  return version;
}

describe('arch-diff on the seed', () => {
  let db: Db;
  const sql = queries.find(([name]) => name === 'arch-diff')?.[1] as string;
  let rows: ArchDiffRow[];
  let digests: string[];

  beforeAll(async () => {
    db = await seededDb(REPO_ROOT, readFileSync(join(REPO_ROOT, 'fixtures', 'seed.sql'), 'utf8'));
    rows = (await db.query(sql, ['mission-control'])) as unknown as ArchDiffRow[];
    const versions = await db.query(
      'SELECT digest FROM mc.versions WHERE factory = $1 ORDER BY first_run_at',
      ['mission-control'],
    );
    digests = versions.map((v) => String(v.digest));
  }, 60_000);

  afterAll(() => db.close());

  test('V1 to V2 is exactly the scripted change: a step added and removed, a prompt and a subagent changed', () => {
    const [v1, v2] = digests;
    const result = diffVersions(rows, v1, v2);
    if (result.status !== 'compared')
      throw new Error(`expected a comparison, got ${result.status}`);
    const listed = KINDS.flatMap((kind) =>
      (['added', 'removed', 'changed'] as const).flatMap((change) =>
        result.diff[kind][change].map((item) => `${change} ${kind} ${itemLabel(item)}`),
      ),
    );
    expect(listed).toEqual([
      'added step archon-loop · tally',
      'removed step archon-loop · briefs',
      'changed prompt loop/commands/loop-review.md',
      'changed subagent archon-manager · manage · holdout-writer',
    ]);
  });

  test('a version against itself has no change, and a version never parsed is unrecorded', () => {
    const [v1, , v3] = digests;
    expect(diffVersions(rows, v1, v1)).toMatchObject({ status: 'compared', changes: 0 });
    expect(diffVersions(rows, v1, v3)).toEqual({ status: 'unrecorded', digests: [v3] });
  });

  test('a version whose pin has no Archon sha yet stays on the strip and is unrecorded, never another', async () => {
    const [v1, v2] = digests;
    const [pin] = await db.query(
      'SELECT p.sha, p.archon_sha FROM mc.versions v JOIN mc.pins p ON p.sha = v.pin_sha WHERE v.digest = $1',
      [v2],
    );
    const strip = queries.find(([name]) => name === 'version-strip')?.[1] as string;
    await db.query('UPDATE mc.pins SET archon_sha = NULL WHERE sha = $1', [pin?.sha]);
    try {
      const unresolved = (await db.query(sql, ['mission-control'])) as unknown as ArchDiffRow[];
      expect(diffVersions(unresolved, v1, v2)).toEqual({ status: 'unrecorded', digests: [v2] });
      const listed = await db.query(strip, ['mission-control']);
      expect(listed.find((r) => r.digest === v2)).toMatchObject({ pin_sha: pin?.sha });
    } finally {
      await db.query('UPDATE mc.pins SET archon_sha = $2 WHERE sha = $1', [
        pin?.sha,
        pin?.archon_sha,
      ]);
    }
  });

  test("names no other factory's versions", async () => {
    expect(await db.query(sql, ['other'])).toEqual([]);
  });

  /**
   * Each architecture table, the columns that name its item, and the columns deliberately not
   * part of what it says. Every other column must count as a change, so a column the query stops
   * hashing, or one a migration adds, fails here.
   */
  const tables: {
    table: string;
    kind: Kind;
    item: (row: Record<string, unknown>) => Item;
    key: string[];
    ignored: string[];
  }[] = [
    {
      table: 'arch_workflows',
      kind: 'workflow',
      item: (r) => ({ kind: 'workflow', workflow: null, step: null, name: String(r.name) }),
      key: ['name'],
      // The YAML text changes whenever any step does, so it would list every edited workflow.
      ignored: ['yaml'],
    },
    {
      table: 'arch_steps',
      kind: 'step',
      item: (r) => ({
        kind: 'step',
        workflow: String(r.workflow),
        step: null,
        name: String(r.path),
      }),
      key: ['workflow', 'path'],
      // Removing a step renumbers the rest; wiring is compared from mc.arch_edges.
      ignored: ['parent_path', 'position', 'step_id', 'depends_on'],
    },
    {
      table: 'arch_texts',
      kind: 'prompt',
      item: (r) => ({ kind: 'prompt', workflow: null, step: null, name: String(r.path) }),
      key: ['path'],
      ignored: [],
    },
    {
      table: 'arch_subagents',
      kind: 'subagent',
      item: (r) => ({
        kind: 'subagent',
        workflow: String(r.workflow),
        step: String(r.step_path),
        name: String(r.name),
      }),
      key: ['workflow', 'step_path', 'name'],
      ignored: [],
    },
  ];

  test.each(tables)(
    'an edit to any column of $table that says something is listed as a changed $kind',
    async ({ table, kind, item, key, ignored }) => {
      const [v1, v2] = digests;
      const baseline = diffVersions(rows, v1, v2);
      if (baseline.status !== 'compared') throw new Error('expected a comparison');
      const scripted = [...baseline.diff[kind].added, ...baseline.diff[kind].changed];
      const version = await archOf(db, v2);
      const candidates = await db.query(
        `SELECT * FROM mc.${table} WHERE archon_sha = $1 AND factory_sha = $2`,
        [version.archon_sha, version.factory_sha],
      );
      const row = candidates.find(
        (r) => !scripted.some((s) => itemLabel(s) === itemLabel(item(r))),
      );
      if (!row) throw new Error(`no ${table} row in V2 that the seed leaves unchanged`);
      const columns = (
        await db.query(
          `SELECT column_name FROM information_schema.columns
           WHERE table_schema = 'mc' AND table_name = $1 ORDER BY ordinal_position`,
          [table],
        )
      )
        .map((c) => String(c.column_name))
        .filter((c) => !['archon_sha', 'factory_sha', ...key, ...ignored].includes(c));
      expect(columns.length).toBeGreaterThan(0);

      const unlisted: string[] = [];
      for (const column of columns) {
        const rollback = new Error('rollback');
        await db
          .transaction(async (tx) => {
            await tx.query(
              `UPDATE mc.${table} SET ${column} = coalesce(${column}, '') || '~'
               WHERE archon_sha = $1 AND factory_sha = $2
                 AND ${key.map((c, i) => `${c} = $${i + 3}`).join(' AND ')}`,
              [version.archon_sha, version.factory_sha, ...key.map((c) => row[c])],
            );
            const edited = (await tx.query(sql, ['mission-control'])) as unknown as ArchDiffRow[];
            const result = diffVersions(edited, v1, v2);
            if (result.status !== 'compared') throw new Error('expected a comparison');
            if (!result.diff[kind].changed.some((c) => itemLabel(c) === itemLabel(item(row)))) {
              unlisted.push(column);
            }
            throw rollback;
          })
          .catch((error) => {
            if (error !== rollback) throw error;
          });
      }
      expect(unlisted).toEqual([]);
    },
  );
});

describe('arch-diff on versions known only from their laps', () => {
  let db: Db;
  const sql = queries.find(([name]) => name === 'arch-diff')?.[1] as string;

  beforeAll(async () => {
    db = await seededDb(REPO_ROOT, readFileSync(join(REPO_ROOT, 'fixtures', 'seed.sql'), 'utf8'));
    // As runs projected before 0008 are until `reconcile:laps` writes their versions.
    await db.query('DELETE FROM mc.versions');
  }, 60_000);

  afterAll(() => db.close());

  test('V1 to V2 is still exactly the scripted change, and V3 is still unrecorded', async () => {
    const rows = (await db.query(sql, ['mission-control'])) as unknown as ArchDiffRow[];
    const [v1, v2, v3] = (
      await db.query(
        `SELECT digest FROM mc.laps WHERE factory = $1 AND digest IS NOT NULL
         GROUP BY digest ORDER BY min(started_at)`,
        ['mission-control'],
      )
    ).map((v) => String(v.digest));
    const result = diffVersions(rows, v1, v2);
    if (result.status !== 'compared')
      throw new Error(`expected a comparison, got ${result.status}`);
    expect(
      KINDS.flatMap((kind) =>
        (['added', 'removed', 'changed'] as const).flatMap((change) =>
          result.diff[kind][change].map((item) => `${change} ${kind} ${itemLabel(item)}`),
        ),
      ),
    ).toEqual([
      'added step archon-loop · tally',
      'removed step archon-loop · briefs',
      'changed prompt loop/commands/loop-review.md',
      'changed subagent archon-manager · manage · holdout-writer',
    ]);
    expect(diffVersions(rows, v1, v3)).toEqual({ status: 'unrecorded', digests: [v3] });
  });
});

describe('lanes and recent-laps on the seed', () => {
  let db: Db;
  const sqlOf = (name: string) => queries.find(([n]) => n === name)?.[1] as string;
  const laps = seedLaps(readFileSync(join(REPO_ROOT, 'fixtures', 'seed.sql'), 'utf8'));
  const finished = laps.filter((l) => !['running', 'paused', 'pending'].includes(l.what));

  beforeAll(async () => {
    db = await seededDb(REPO_ROOT, readFileSync(join(REPO_ROOT, 'fixtures', 'seed.sql'), 'utf8'));
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

describe('one-lap on the seed', () => {
  let db: Db;
  const sqlOf = (name: string) => queries.find(([n]) => n === name)?.[1] as string;
  const seed = readFileSync(join(REPO_ROOT, 'fixtures', 'seed.sql'), 'utf8');
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
    db = await seededDb(REPO_ROOT, seed);
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
      ['completed', new Date(Date.parse('2026-10-25T12:20:00Z') - 184_250), null, null],
      ['completed', new Date(Date.parse('2026-10-25T13:20:00Z') - 184_250), 'sonnet', 48_210],
    ]);
    expect(shown.reduce((sum, r) => sum + Number(r.cost_usd), 0)).toBeCloseTo(0.8426);
    expect(await errors()).toEqual(before);
  });
});
