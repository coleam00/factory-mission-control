import { afterAll, beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { PGlite, type Transaction } from '@electric-sql/pglite';
import type { Db, Row, Tx } from '../scripts/lib/db';
import { migrationsDir, readMigrationFiles, runMigrations } from '../scripts/migrate';

const RUN_ID = '00000000-0000-0000-0000-000000000001';

const pg = new PGlite();
const files = readMigrationFiles(migrationsDir(join(import.meta.dir, '..')));
let firstRun: string[] = [];

/** Without params a migration file is several statements, which only exec runs. */
function txOn(client: PGlite | Transaction): Tx {
  return {
    async query(sql, params) {
      if (params) return (await client.query<Row>(sql, params)).rows;
      return ((await client.exec(sql)).at(-1)?.rows as Row[] | undefined) ?? [];
    },
  };
}

const db: Db = {
  ...txOn(pg),
  async transaction(fn) {
    await pg.transaction((tx) => fn(txOn(tx)));
  },
  close: () => pg.close(),
};

beforeAll(async () => {
  await db.query('CREATE TABLE public.remote_agent_workflow_runs (id uuid PRIMARY KEY)');
  firstRun = await runMigrations({ files, db });
});
afterAll(() => db.close());

test('applies every migration once and none on a second run', async () => {
  expect(firstRun).toEqual(files.map((file) => file.name));
  expect(await runMigrations({ files, db })).toEqual([]);
  for (const file of files) await db.query(file.sql);
});

test('gives every table in mc a primary key, one table per family', async () => {
  const withoutPk = await db.query(`
    SELECT t.table_name FROM information_schema.tables t
    WHERE t.table_schema = 'mc' AND t.table_type = 'BASE TABLE'
      AND NOT EXISTS (SELECT 1 FROM information_schema.table_constraints c
        WHERE c.table_schema = t.table_schema AND c.table_name = t.table_name
          AND c.constraint_type = 'PRIMARY KEY')`);
  expect(withoutPk).toEqual([]);

  const tables = (
    await db.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'mc' AND table_type = 'BASE TABLE'`,
    )
  ).map((row) => row.table_name);
  expect(tables).toEqual(
    expect.arrayContaining([
      'factories',
      'issues',
      'issue_labels',
      'issue_dependencies',
      'comments',
      'pull_requests',
      'claims',
      'reviews',
      'owner_questions',
      'metrics_lines',
      'holdout_verdicts',
      'pins',
      'verdicts',
      'versions',
      'decisions',
      'arch_workflows',
      'arch_steps',
      'arch_edges',
      'arch_texts',
      'arch_scripts',
      'arch_subagents',
      'arch_hooks',
      'laps',
      'lap_steps',
      'app_check_lines',
      'projection_errors',
    ]),
  );
});

test('keeps holdout tables to ids, verdicts, kinds and pre_existing', async () => {
  const textColumns = await db.query(`
    SELECT table_name, column_name FROM information_schema.columns
    WHERE table_schema = 'mc' AND table_name IN ('holdout_verdicts', 'app_check_lines')
      AND data_type IN ('text', 'character varying', 'character', 'json', 'jsonb', 'ARRAY', 'USER-DEFINED')
    ORDER BY table_name, column_name`);
  expect(textColumns).toEqual([
    { table_name: 'app_check_lines', column_name: 'kind' },
    { table_name: 'app_check_lines', column_name: 'pre_existing' },
    { table_name: 'app_check_lines', column_name: 'scenario_id' },
    { table_name: 'app_check_lines', column_name: 'verdict' },
    { table_name: 'holdout_verdicts', column_name: 'scenario_id' },
    { table_name: 'holdout_verdicts', column_name: 'verdict' },
  ]);
});

const appCheckLine = (position: number, kind: string, verdict: string, scenarioId: string | null) =>
  db.query(
    `INSERT INTO mc.app_check_lines (run_id, position, kind, verdict, evidence_count, scenario_id)
     VALUES ($1, $2, $3, $4, 1, $5)`,
    [RUN_ID, position, kind, verdict, scenarioId],
  );

const lapStep = (stepId: string, output: unknown) =>
  db.query(
    `INSERT INTO mc.lap_steps (run_id, step_id, status, output) VALUES ($1, $2, 'completed', $3)`,
    [RUN_ID, stepId, output === null ? null : JSON.stringify(output)],
  );

test('refuses holdout text wherever a line could carry it', async () => {
  await expect(
    appCheckLine(1, 'holdout', 'FAIL', 'H-03 the user sees HOLDOUT-TEXT-MARKER'),
  ).rejects.toThrow('app_check_lines_scenario_id_check');
  await expect(appCheckLine(2, 'holdout', 'FAIL', null)).rejects.toThrow('app_check_lines_check');
  await expect(appCheckLine(3, 'probe', 'the user sees x', null)).rejects.toThrow(
    'app_check_lines_verdict_check',
  );
  await expect(
    db.query(
      `INSERT INTO mc.holdout_verdicts (report_id, scenario_id, verdict) VALUES (1, $1, 'PASS')`,
      ['H-03 the user sees HOLDOUT-TEXT-MARKER'],
    ),
  ).rejects.toThrow('holdout_verdicts_scenario_id_check');
  await expect(lapStep('check-app', { lines: [], overall: 'PASS' })).rejects.toThrow(
    'lap_steps_output_check',
  );

  await appCheckLine(4, 'holdout', 'FAIL', 'unidentified');
  await appCheckLine(5, 'holdout', 'PASS', 'H-07');
  await lapStep('check-app-ok', { overall: 'PASS' });
  await lapStep('pick', null);
});

test("leaves Archon's schema alone", async () => {
  const publicTables = (
    await db.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`,
    )
  ).map((row) => row.table_name);
  expect(publicTables).toEqual(['mc_schema_migrations', 'remote_agent_workflow_runs']);

  const triggers = await db.query(`
    SELECT t.tgname FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND NOT t.tgisinternal`);
  expect(triggers).toEqual([]);
});
