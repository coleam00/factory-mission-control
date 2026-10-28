import { afterEach, expect, test } from 'bun:test';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { archonDb, migrationFiles } from '../db/test-db';
import type { Row } from '../scripts/lib/db';
import { recordingDeps, scratchRepo } from '../scripts/lib/test-deps';
import { runMigrations } from '../scripts/migrate';
import { type SyncDeps, syncFactoriesAtStart } from './factory-sync';

const HOME = 'postgresql://u:p@ep-home-a1b2c3.us-east-2.aws.neon.tech/db';
const MISSION_CONTROL = {
  name: 'mission-control',
  repository: 'coleam00/factory-mission-control',
  codebase: 'coleam00/factory-mission-control',
  console: 'http://localhost:3091',
};
const SECOND = {
  name: 'second-factory',
  repository: 'example/second',
  codebase: 'example/second',
  console: 'http://localhost:3093',
};

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A scratch repository whose served factories file holds `config`, and deps over it. */
function serving(
  config: unknown,
  options: { branchName?: string; rows?: (sql: string) => Row[]; throwsOn?: string[] } = {},
  env: Record<string, string> = { MC_DATABASE_URL: HOME, NEON_API_KEY: 'key' },
) {
  const repoRoot = scratchRepo();
  scratch.push(repoRoot);
  const file = join(repoRoot, 'served.json');
  writeFileSync(file, JSON.stringify(config));
  const run = recordingDeps({ repoRoot, env: { ...env, MC_FACTORIES_FILE: file }, ...options });
  const deps: SyncDeps = run.deps;
  return { run, deps };
}

test('on a check-* branch it loads the served file, deleting no factory', async () => {
  const db = await archonDb();
  try {
    await runMigrations({ files: migrationFiles, db });
    await db.query(`INSERT INTO mc.factories VALUES
      ('mission-control', 'coleam00/factory-mission-control', 'coleam00/factory-mission-control',
        'http://localhost:3090'),
      ('retired', 'example/old', 'example/old', 'http://localhost:3092')`);
    const { run, deps } = serving(
      { factories: [MISSION_CONTROL, SECOND] },
      { branchName: 'check-abc' },
    );

    const note = await syncFactoriesAtStart({
      ...deps,
      openDb: (url) => {
        run.opened.push(url);
        return { ...db, close: async () => {} };
      },
    });

    expect(note).toBe(
      'factories synced on check-abc: 2 factory row(s) written, 0 lap(s) re-attributed',
    );
    expect(run.opened).toEqual([HOME]);
    expect(await db.query('SELECT name, console FROM mc.factories ORDER BY name')).toEqual([
      { name: 'mission-control', console: 'http://localhost:3091' },
      { name: 'retired', console: 'http://localhost:3092' },
      { name: 'second-factory', console: 'http://localhost:3093' },
    ]);
  } finally {
    await db.close();
  }
});

test.each(['main', 'rewind-x', 'fixture'])(
  'on branch %s it neither reads the file nor connects',
  async (branchName) => {
    const { run, deps } = serving({}, { branchName });
    expect(await syncFactoriesAtStart(deps)).toBe(
      `factories not synced: serve writes only check-* branches, not ${branchName}`,
    );
    expect(run.opened).toEqual([]);
    expect(run.sql).toEqual([]);
    expect(run.mutatingCalls).toEqual([]);
  },
);

test('without MC_DATABASE_URL it says nothing and asks nothing', async () => {
  const { run, deps } = serving({}, {}, { NEON_API_KEY: 'key' });
  expect(await syncFactoriesAtStart(deps)).toBeUndefined();
  expect(run.neonCalls).toEqual([]);
  expect(run.opened).toEqual([]);
});

test('without NEON_API_KEY it serves unsynced, asking Neon nothing', async () => {
  const { run, deps } = serving({}, {}, { MC_DATABASE_URL: HOME });
  expect(await syncFactoriesAtStart(deps)).toBe(
    'factories not synced: NEON_API_KEY and NEON_PROJECT_ID are needed to tell a check-* branch',
  );
  expect(run.neonCalls).toEqual([]);
  expect(run.opened).toEqual([]);
});

test('when Neon cannot name the branch it serves unsynced without connecting', async () => {
  const { run, deps } = serving({}, { throwsOn: ['getBranch br-target'] });
  expect(await syncFactoriesAtStart(deps)).toBe(
    'factories not synced: could not tell the branch (fake Neon: getBranch br-target failed)',
  );
  expect(run.opened).toEqual([]);
});

test('a failed sync on a check-* branch rejects with its error', async () => {
  const { deps } = serving(
    { factories: [MISSION_CONTROL] },
    {
      branchName: 'check-abc',
      rows: () => {
        throw new Error('relation "mc.factories" does not exist');
      },
    },
  );
  await expect(syncFactoriesAtStart(deps)).rejects.toThrow(
    'relation "mc.factories" does not exist',
  );
});

test('a malformed served file on a check-* branch rejects before connecting', async () => {
  const { run, deps } = serving({}, { branchName: 'check-abc' });
  await expect(syncFactoriesAtStart(deps)).rejects.toThrow('Invalid factories configuration:');
  expect(run.opened).toEqual([]);
});
