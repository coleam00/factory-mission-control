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
import { OUTCOMES } from '../app/lib/laps';
import {
  dataValue,
  type MeasureKey,
  type ScorecardRow,
  scorecard,
  versionLaps,
  versionPin,
} from '../app/lib/scorecard';
import { joinParts } from '../app/lib/step-detail';
import { seededDb } from '../scripts/fixture/seed';
import { seedLaps } from '../scripts/fixture/seed-laps';
import { eventData, writeRow } from '../scripts/fixture/write';
import { REPO_ROOT } from '../scripts/lib/cli';
import type { Db } from '../scripts/lib/db';
import { runMigrations } from '../scripts/migrate';
import { LIVE_QUERY_NAME, loadLiveQueries, parameterCount } from '../server/live';
import { archonDb, migrationFiles } from './test-db';

const dir = join(import.meta.dir, 'queries');
const queries = [...loadLiveQueries(dir)];

/** The step screen's panels below step-detail: keyed by the step's workflow and path too. */
const STEP_PANELS = ['step-prompt', 'step-subagents', 'step-scripts', 'step-hooks', 'step-yaml'];
const CHECK_APP = ['archon-loop', 'check-app'];
const paramsFor = (name: string, factory: string) =>
  STEP_PANELS.includes(name) ? [factory, ...CHECK_APP] : [factory];

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

  test("is keyed by one factory, $1, and a step panel's by the step's workflow and path", () => {
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
        'SELECT sum(cost_usd)::float8 AS c FROM mc.lap_steps WHERE run_id = $1',
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

  test('another factory sees none of these laps', async () => {
    expect(await db.query(sqlOf('lanes'), ['other'])).toEqual([]);
    expect(await db.query(sqlOf('recent-laps'), ['other'])).toEqual([]);
  });
});
