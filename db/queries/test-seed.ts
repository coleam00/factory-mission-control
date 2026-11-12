import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runsArgs } from '../../app/lib/runs';
import { seededDb } from '../../scripts/fixture/seed';
import { REPO_ROOT } from '../../scripts/lib/cli';
import type { Db } from '../../scripts/lib/db';
import { runMigrations } from '../../scripts/migrate';
import { loadLiveQueries } from '../../server/live';
import { archonDb, migrationFiles, type TestDb } from '../test-db';

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
  'step-yaml',
];
export const CHECK_APP = ['archon-loop', 'check-app'];
/** The one-lap screen's panels: keyed by the lap's run id too. */
export const LAP_PANELS = ['one-lap', 'one-lap-steps', 'one-lap-checks', 'one-lap-map'];
export const LAP_RUN = '5eed0001-0000-4000-8000-000000000003';
/** failure-groups' `$2` on the seed: 7 days before its newest stop (2026-10-24T11:35Z), so the seed's failures are still unresolved by age. */
export const SEED_FAILURES_SINCE = '2026-10-17T11:00:00.000Z';
/** The home map and step-detail take the version's pin as $2, '' for the current version. */
export const paramsFor = (name: string, factory: string) =>
  name === 'step-detail' || name === 'home-map'
    ? [factory, '']
    : name === 'factory-scorecard'
      ? [factory, '2026-11-12']
      : name === 'failure-groups'
        ? [factory, SEED_FAILURES_SINCE]
        : name === 'work-item'
          ? [factory, '3']
          : STEP_PANELS.includes(name)
            ? [factory, ...CHECK_APP, '']
            : name === 'runs'
              ? [factory, ...runsArgs({ q: '', state: '', hideIdle: false, page: 1 })]
              : LAP_PANELS.includes(name)
                ? [factory, LAP_RUN]
                : [factory];

export const SEED = readFileSync(join(REPO_ROOT, 'fixtures', 'seed.sql'), 'utf8');

/** A fresh database holding fixtures/seed.sql. */
export const onTheSeed = (): Promise<Db> => seededDb(REPO_ROOT, SEED);

/** A fresh database with every migration applied and no rows. */
export async function migratedDb(): Promise<TestDb> {
  const db = await archonDb();
  await runMigrations({ files: migrationFiles, db });
  return db;
}
