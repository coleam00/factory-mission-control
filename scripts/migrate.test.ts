import { afterEach, expect, test } from 'bun:test';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  expect(run.out.join('\n')).toContain('bun run migrate -- --configured-factories');
  expect(run.out.join('\n')).toContain('bun run migrate:main -- --configured-factories');
  expect(run.out.join('\n')).toContain('MC_FACTORIES_FILE');
  expect(run.out.join('\n')).toContain('MC_DATABASE_URL');
  expect(run.out.join('\n')).toContain('NEON_API_KEY and NEON_PROJECT_ID');
  expect(run.out.join('\n')).toContain('Rewind branches are read-only');
  expect(run.neonCalls).toEqual([]);
  expect(run.opened).toEqual([]);
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

test.each(['default', 'override'])(
  'configured factories loads a factory added after migration from the %s file',
  async (source) => {
    const repoRoot = repo();
    cpSync(migrationsDir(REPO_ROOT), migrationsDir(repoRoot), { recursive: true });
    const file = join(repoRoot, source === 'default' ? 'factories.json' : 'custom.json');
    const added = {
      name: 'new-factory',
      repository: 'example/new',
      codebase: 'example/new',
      console: 'http://localhost:3091',
    };
    writeFileSync(file, JSON.stringify({ factories: FACTORIES }));
    const db = await archonDb();
    try {
      const run = recordingDeps({
        repoRoot,
        env: source === 'override' ? { MC_FACTORIES_FILE: file } : {},
      });
      const deps = { ...run.deps, openDb: () => ({ ...db, close: async () => {} }) };
      const argv = ['--configured-factories'];
      expect(await main(argv, deps)).toBe(0);
      await db.query(
        `INSERT INTO mc.factories VALUES ('retired', 'example/old', 'example/old', 'http://localhost:3092')`,
      );
      const createRun = async (codebase: string) => {
        const [row] = await db.query(
          `WITH c AS (
          INSERT INTO public.remote_agent_codebases (name) VALUES ($1) RETURNING id
        ) INSERT INTO public.remote_agent_workflow_runs (workflow_name, codebase_id, status, user_message)
          SELECT 'archon-loop', id, 'running', 'Run the loop' FROM c RETURNING id`,
          [codebase],
        );
        return row.id;
      };
      const original = await createRun(FACTORIES[0].codebase);
      const pending = await createRun(added.codebase);
      await createRun('example/other');
      const query = (name: string, factory: string) =>
        db.query(readFileSync(join(REPO_ROOT, 'db', 'queries', `${name}.sql`), 'utf-8'), [factory]);
      const originalLaps = await db.query('SELECT * FROM mc.laps WHERE run_id = $1', [original]);
      const sourceRows = await db.query(
        'SELECT * FROM public.remote_agent_workflow_runs ORDER BY id',
      );
      const codebases = await db.query('SELECT * FROM public.remote_agent_codebases ORDER BY id');
      const unrelated = await db.query(
        'SELECT * FROM mc.laps WHERE run_id NOT IN ($1, $2) ORDER BY run_id',
        [original, pending],
      );
      const registry = await db.query('SELECT * FROM mc.factories ORDER BY name');
      expect(await query('factory-switcher', FACTORIES[0].name)).not.toContainEqual(
        expect.objectContaining({ factory: added.name }),
      );
      expect(await query('status-strip', added.name)).toEqual([{ running: 0 }]);
      expect(await query('lanes', added.name)).toEqual([]);

      writeFileSync(file, JSON.stringify({ factories: [...FACTORIES, added] }));
      expect(await main(argv, deps)).toBe(0);
      expect(run.out.at(-1)).toBe(
        'configured factories: 1 factory row(s) written, 1 lap(s) re-attributed',
      );
      expect(await query('factory-switcher', FACTORIES[0].name)).toContainEqual({
        factory: added.name,
        running: 1,
        is_default: false,
      });
      expect(await query('status-strip', added.name)).toEqual([{ running: 1 }]);
      expect(await query('lanes', added.name)).toEqual([
        expect.objectContaining({ run_id: pending }),
      ]);
      expect(await db.query('SELECT * FROM mc.laps WHERE run_id = $1', [original])).toEqual(
        originalLaps,
      );
      expect(await query('status-strip', FACTORIES[0].name)).toEqual([{ running: 1 }]);
      expect(await db.query('SELECT * FROM public.remote_agent_workflow_runs ORDER BY id')).toEqual(
        sourceRows,
      );
      expect(await db.query('SELECT * FROM public.remote_agent_codebases ORDER BY id')).toEqual(
        codebases,
      );
      expect(
        await db.query('SELECT * FROM mc.laps WHERE run_id NOT IN ($1, $2) ORDER BY run_id', [
          original,
          pending,
        ]),
      ).toEqual(unrelated);
      expect(
        await db.query('SELECT * FROM mc.factories WHERE name <> $1 ORDER BY name', [added.name]),
      ).toEqual(registry);
      const once = await snapshot(db);
      expect(await main(argv, deps)).toBe(0);
      expect(await snapshot(db)).toEqual(once);
      const next = await createRun(added.codebase);
      expect(await db.query('SELECT factory FROM mc.laps WHERE run_id = $1', [next])).toEqual([
        { factory: added.name },
      ]);
      expect(await query('status-strip', added.name)).toEqual([{ running: 2 }]);
    } finally {
      await db.close();
    }
  },
);

test.each(['main', 'fixture', 'rewind-before-setup'])(
  'configured factories refuses %s before reading configuration or connecting',
  async (branchName) => {
    const run = recordingDeps({ repoRoot: repo(), branchName });
    expect(await main(['--configured-factories'], run.deps)).toBe(1);
    expect(run.err.join('\n')).toContain(`refusing branch '${branchName}'`);
    expect(run.opened).toEqual([]);
    expect(run.mutatingCalls).toEqual([]);
  },
);

test.each(['check-abc', 'fixture', 'rewind-before-setup', 'main'])(
  'configured main migration keeps branch and terminal authorization on %s',
  async (branchName) => {
    const run = recordingDeps({ repoRoot: repo(), branchName, owner: branchName !== 'main' });
    expect(await main(['--main', '--configured-factories'], run.deps)).toBe(1);
    expect(run.err.join('\n')).toContain(
      branchName === 'main' ? 'owner, at a terminal' : `refusing branch '${branchName}'`,
    );
    expect(run.opened).toEqual([]);
  },
);

test('configured main migration reads the selected file after owner confirmation', async () => {
  const repoRoot = repo();
  writeFileSync(join(repoRoot, 'factories.json'), JSON.stringify({ factories: FACTORIES }));
  const run = recordingDeps({ repoRoot, branchName: 'main', owner: true });
  expect(await main(['--main', '--configured-factories'], run.deps)).toBe(0);
  expect(run.opened).toEqual([DATABASE_URL]);
  expect(run.params).toContainEqual([FACTORIES]);
});

test('ordinary migration ignores the override while configured migration reads check environment', async () => {
  const repoRoot = repo();
  const file = join(repoRoot, 'custom.json');
  writeFileSync(file, JSON.stringify({ factories: [] }));
  writeFileSync(
    join(repoRoot, '.mc-check.env'),
    `MC_DATABASE_URL=${DATABASE_URL}\nMC_FACTORIES_FILE=${file}\n`,
  );
  const ordinary = recordingDeps({ repoRoot });
  expect(await main([], ordinary.deps)).toBe(0);
  expect(ordinary.params).toContainEqual([FACTORIES]);
  const configured = recordingDeps({ repoRoot });
  expect(await main(['--configured-factories'], configured.deps)).toBe(0);
  expect(configured.params).toContainEqual([[]]);
});

test('configured migration fails on a bad selected file before opening the database', async () => {
  const repoRoot = repo();
  const file = join(repoRoot, 'custom.json');
  writeFileSync(file, '{broken');
  const run = recordingDeps({ repoRoot, env: { MC_FACTORIES_FILE: file } });
  expect(await main(['--configured-factories'], run.deps)).toBe(1);
  expect(run.opened).toEqual([]);
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
