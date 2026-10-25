import { afterEach, expect, test } from 'bun:test';
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { archonDb, migrationFiles, snapshot } from '../db/test-db';
import factories from '../factories.json';
import type { Db } from './lib/db';
import { DATABASE_URL, recordingDeps, scratchRepo } from './lib/test-deps';
import { loadFactories, main, migrationsDir, readMigrationFiles, runMigrations } from './migrate';

const REPO_ROOT = join(import.meta.dir, '..');
const FACTORIES = factories.factories;

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function repo(): string {
  const dir = scratchRepo({ MC_DATABASE_URL: DATABASE_URL });
  scratch.push(dir);
  return dir;
}

test.each(['main', 'fixture', 'rewind-x'])(
  'refuses a database URL on branch %s without connecting',
  async (branchName) => {
    const run = recordingDeps({ repoRoot: repo(), branchName });
    expect(await main([], run.deps)).not.toBe(0);
    expect(run.mutatingCalls).toEqual([]);
    expect(run.opened).toEqual([]);
    expect(run.err.join('\n')).toContain(`refusing branch '${branchName}'`);
  },
);

test.each([[['--help']], [['-h']]])('prints usage for %j without touching Neon', async (argv) => {
  const run = recordingDeps({ repoRoot: repo() });
  expect(await main(argv, run.deps)).toBe(0);
  expect(run.out.join('\n')).toContain('usage: bun run migrate');
  expect(run.neonCalls).toEqual([]);
});

test.each([[['--force']], [['main']]])(
  'exits 2 with usage for %j before touching Neon',
  async (argv) => {
    const run = recordingDeps({ repoRoot: repo() });
    expect(await main(argv, run.deps)).toBe(2);
    expect(run.err.join('\n')).toContain('usage: bun run migrate');
    expect(run.neonCalls).toEqual([]);
  },
);

test('migrate:main refuses every branch but main, check-* included', async () => {
  const run = recordingDeps({ repoRoot: repo(), branchName: 'check-abc', owner: true });
  expect(await main(['--main'], run.deps)).not.toBe(0);
  expect(run.opened).toEqual([]);
});

test('migrate:main refuses main unless the owner confirms at a terminal', async () => {
  const run = recordingDeps({ repoRoot: repo(), branchName: 'main', owner: false });
  expect(await main(['--main'], run.deps)).not.toBe(0);
  expect(run.opened).toEqual([]);
});

test('migrate applies the pending files on a check-* branch', async () => {
  const repoRoot = repo();
  mkdirSync(migrationsDir(repoRoot), { recursive: true });
  writeFileSync(join(migrationsDir(repoRoot), '0001_a.sql'), 'SELECT 1;');
  const run = recordingDeps({ repoRoot, branchName: 'check-abc' });
  expect(await main([], run.deps)).toBe(0);
  expect(run.opened).toEqual([DATABASE_URL]);
  expect(run.out).toEqual([
    'applied 0001_a.sql',
    'applied 1 migration(s)',
    'factories.json: 0 factory row(s) written, 0 lap(s) re-attributed',
  ]);
});

test('migrate leaves a fresh database with exactly the factories of factories.json, once', async () => {
  const repoRoot = repo();
  cpSync(migrationsDir(REPO_ROOT), migrationsDir(repoRoot), { recursive: true });
  const db = await archonDb();
  try {
    const run = recordingDeps({ repoRoot, branchName: 'check-abc' });
    const deps = { ...run.deps, openDb: () => ({ ...db, close: async () => {} }) };

    expect(await main([], deps)).toBe(0);
    expect(run.out.at(-1)).toBe(
      `factories.json: ${FACTORIES.length} factory row(s) written, 0 lap(s) re-attributed`,
    );
    expect(await db.query('SELECT * FROM mc.factories ORDER BY name')).toEqual(
      [...FACTORIES].sort((a, b) => a.name.localeCompare(b.name)),
    );

    const once = await snapshot(db);
    run.out.length = 0;
    expect(await main([], deps)).toBe(0);
    expect(run.out).toEqual([
      'applied 0 migration(s)',
      'factories.json: 0 factory row(s) written, 0 lap(s) re-attributed',
    ]);
    expect(await snapshot(db)).toEqual(once);
  } finally {
    await db.close();
  }
});

test('loading the factories updates stale rows and attributes the laps projected before them, nothing else', async () => {
  const db = await archonDb();
  try {
    await runMigrations({ files: migrationFiles, db });
    await db.query(`INSERT INTO mc.factories VALUES
      ('retired', 'coleam00/retired', 'coleam00/retired', 'http://localhost:3091'),
      ('mission-control', 'coleam00/old-name', 'coleam00/old-name', 'http://localhost:9999')`);
    const codebase = async (name: string) =>
      String(
        (
          await db.query(
            'INSERT INTO public.remote_agent_codebases (name) VALUES ($1) RETURNING id',
            [name],
          )
        )[0]?.id,
      );
    const run = async (codebaseId: string | null) =>
      String(
        (
          await db.query(
            `INSERT INTO public.remote_agent_workflow_runs (workflow_name, codebase_id, user_message)
             VALUES ('archon-loop', $1, 'Run the loop') RETURNING id`,
            [codebaseId],
          )
        )[0]?.id,
      );
    const ours = await codebase('coleam00/factory-mission-control');
    const named = await run(ours);
    const empty = await run(ours);
    await db.query(`UPDATE mc.laps SET factory = '' WHERE run_id = $1`, [empty]);
    const other = await run(await codebase('mc-fence-proof'));
    const none = await run(null);
    const factoryOf = async () =>
      Object.fromEntries(
        (await db.query('SELECT run_id, factory FROM mc.laps')).map((r) => [r.run_id, r.factory]),
      );
    expect(await factoryOf()).toEqual({
      [named]: 'coleam00/factory-mission-control',
      [empty]: '',
      [other]: 'mc-fence-proof',
      [none]: '',
    });

    expect(await loadFactories({ entries: FACTORIES, db })).toEqual({ factories: 1, laps: 2 });
    expect(await db.query(`SELECT * FROM mc.factories WHERE name = 'mission-control'`)).toEqual(
      FACTORIES,
    );
    expect(await factoryOf()).toEqual({
      [named]: 'mission-control',
      [empty]: 'mission-control',
      [other]: 'mc-fence-proof',
      [none]: '',
    });
    expect(await db.query('SELECT name FROM mc.factories ORDER BY name')).toEqual([
      { name: 'mission-control' },
      { name: 'retired' },
    ]);
    expect(await loadFactories({ entries: FACTORIES, db })).toEqual({ factories: 0, laps: 0 });
  } finally {
    await db.close();
  }
});

/**
 * PGlite reads a string bound to `::jsonb` as JSON text; Bun's client sends it as a jsonb string.
 * This `Db` binds every string the way Bun does, so a stringified jsonb parameter fails here too.
 */
function bunJsonb(db: Db): Db {
  const bind = (params?: unknown[]) =>
    params?.map((value) => (typeof value === 'string' ? JSON.stringify(value) : value));
  return {
    ...db,
    query: (sql, params) => db.query(sql, bind(params)),
    transaction: (fn) =>
      db.transaction((tx) => fn({ query: (sql, params) => tx.query(sql, bind(params)) })),
  };
}

test('loading the factories binds them as a jsonb array, which Bun sends unchanged', async () => {
  const db = await archonDb();
  try {
    await runMigrations({ files: migrationFiles, db });
    expect(await loadFactories({ entries: FACTORIES, db: bunJsonb(db) })).toEqual({
      factories: FACTORIES.length,
      laps: 0,
    });
    expect(await db.query('SELECT * FROM mc.factories ORDER BY name')).toEqual(
      [...FACTORIES].sort((a, b) => a.name.localeCompare(b.name)),
    );
  } finally {
    await db.close();
  }
});

test('a second run over the same recorded state applies nothing', async () => {
  const repoRoot = repo();
  const dir = migrationsDir(repoRoot);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '0002_b.sql'), 'CREATE TABLE b (id int PRIMARY KEY);');
  writeFileSync(join(dir, '0001_a.sql'), 'CREATE TABLE a (id int PRIMARY KEY);');

  const recorded = new Set<string>();
  const statements: string[] = [];
  const db: Db = {
    async query(sql, params) {
      statements.push(sql);
      if (sql.startsWith('INSERT INTO mc_schema_migrations')) recorded.add(String(params?.[0]));
      if (sql.startsWith('SELECT name FROM mc_schema_migrations')) {
        return [...recorded].map((name) => ({ name }));
      }
      return [];
    },
    async transaction(fn) {
      await fn(db);
    },
    async close() {},
  };

  const files = readMigrationFiles(dir);
  expect(await runMigrations({ files, db })).toEqual(['0001_a.sql', '0002_b.sql']);
  statements.length = 0;
  expect(await runMigrations({ files, db })).toEqual([]);
  expect(statements.some((sql) => sql.startsWith('CREATE TABLE a'))).toBe(false);
  expect(statements.some((sql) => sql.startsWith('INSERT'))).toBe(false);
});

test('a failing file is named, with the files committed before it', async () => {
  const db: Db = {
    async query(sql) {
      if (sql === 'BROKEN') throw new Error('syntax error at or near "BROKEN"');
      return [];
    },
    async transaction(fn) {
      await fn(db);
    },
    async close() {},
  };
  const files = [
    { name: '0001_a.sql', sql: 'SELECT 1;' },
    { name: '0002_b.sql', sql: 'BROKEN' },
  ];
  await expect(runMigrations({ files, db })).rejects.toThrow(
    '0002_b.sql failed after applying 0001_a.sql: syntax error at or near "BROKEN"',
  );
});
