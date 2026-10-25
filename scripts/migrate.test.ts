import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './lib/cli';
import type { Db } from './lib/db';
import { DATABASE_URL, recordingDeps, scratchRepo } from './lib/test-deps';
import { main, migrationsDir, readMigrationFiles, runMigrations } from './migrate';

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
  expect(run.out).toEqual(['applied 0001_a.sql', 'applied 1 migration(s)']);
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

test('the migration set is empty', () => {
  expect(readMigrationFiles(migrationsDir(REPO_ROOT))).toEqual([]);
});
