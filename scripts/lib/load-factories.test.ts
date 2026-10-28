import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { archonDb, migrationFiles } from '../../db/test-db';
import factories from '../../factories.json';
import { runMigrations } from '../migrate';
import type { Db } from './db';
import { loadFactories } from './load-factories';

const REPO_ROOT = join(import.meta.dir, '..', '..');
const FACTORIES = factories.factories;
/** One factory, independent of what the committed factories.json lists. */
const MISSION_CONTROL = [
  {
    name: 'mission-control',
    repository: 'coleam00/factory-mission-control',
    codebase: 'coleam00/factory-mission-control',
    console: 'http://localhost:3090',
  },
];

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

    expect(await loadFactories({ entries: MISSION_CONTROL, db })).toEqual({
      factories: 1,
      laps: 2,
    });
    expect(await db.query(`SELECT * FROM mc.factories WHERE name = 'mission-control'`)).toEqual(
      MISSION_CONTROL,
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
    expect(await loadFactories({ entries: MISSION_CONTROL, db })).toEqual({
      factories: 0,
      laps: 0,
    });
  } finally {
    await db.close();
  }
});

test('a factory registered after its runs lists their versions on the version strip', async () => {
  const db = await archonDb();
  try {
    await runMigrations({ files: migrationFiles, db });
    const [codebase] = await db.query(
      `INSERT INTO public.remote_agent_codebases (name) VALUES ('coleam00/late-factory') RETURNING id`,
    );
    await db.query(
      `INSERT INTO public.remote_agent_workflow_runs (workflow_name, codebase_id, status, user_message,
        metadata, started_at, completed_at)
      VALUES ('archon-loop', $1, 'completed', 'Run the loop', $2::jsonb,
        '2026-10-20T00:00:00Z', '2026-10-20T00:10:00Z')`,
      [codebase?.id, JSON.stringify({ workflow_source: { digest: 'sha256:late' } })],
    );
    expect(await db.query('SELECT * FROM mc.versions')).toEqual([]);

    const late = {
      name: 'late-factory',
      repository: 'coleam00/late-factory',
      codebase: 'coleam00/late-factory',
      console: 'http://localhost:3092',
    };
    expect(await loadFactories({ entries: [late], db })).toEqual({ factories: 1, laps: 1 });
    expect(await db.query('SELECT factory, digest FROM mc.versions')).toEqual([
      { factory: 'late-factory', digest: 'sha256:late' },
    ]);
    const strip = readFileSync(join(REPO_ROOT, 'db/queries/version-strip.sql'), 'utf8');
    expect(
      (await db.query(strip, ['late-factory'])).filter((r) => r.digest !== null),
    ).toMatchObject([{ digest: 'sha256:late' }]);
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
