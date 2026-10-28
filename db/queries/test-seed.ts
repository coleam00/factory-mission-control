import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { seededDb } from '../../scripts/fixture/seed';
import { REPO_ROOT } from '../../scripts/lib/cli';
import type { Db } from '../../scripts/lib/db';
import { runMigrations } from '../../scripts/migrate';
import { loadLiveQueries } from '../../server/live';
import { archonDb, migrationFiles } from '../test-db';

/** Every live query in db/queries/, by name. */
export const queries = [...loadLiveQueries(import.meta.dir)];

/**
 * The step screen's panels below step-detail: keyed by the step's workflow and path too. Every step
 * query takes the version's pin last, '' for the current version.
 */
export const STEP_PANELS = [
  'step-nesting',
  'step-prompt',
  'step-subagents',
  'step-scripts',
  'step-hooks',
  'step-yaml',
];
export const CHECK_APP = ['archon-loop', 'check-app'];
/** The one-lap screen's panels: keyed by the lap's run id too. */
export const LAP_PANELS = ['one-lap', 'one-lap-steps', 'one-lap-checks', 'one-lap-map'];
export const LAP_RUN = '5eed0001-0000-4000-8000-000000000003';
export const paramsFor = (name: string, factory: string) =>
  name === 'step-detail'
    ? [factory, '']
    : STEP_PANELS.includes(name)
      ? [factory, ...CHECK_APP, '']
      : LAP_PANELS.includes(name)
        ? [factory, LAP_RUN]
        : [factory];

export const SEED = readFileSync(join(REPO_ROOT, 'fixtures', 'seed.sql'), 'utf8');

/** A fresh database holding fixtures/seed.sql. */
export const onTheSeed = (): Promise<Db> => seededDb(REPO_ROOT, SEED);

/** A fresh database with every migration applied and no rows. */
export async function migratedDb(): Promise<Db> {
  const db = await archonDb();
  await runMigrations({ files: migrationFiles, db });
  return db;
}
