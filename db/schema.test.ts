import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { CheckLine } from '../fixtures/pack/sdlc/.shared/merge-gate';
import { REVIEW_OUTCOMES, type Review } from '../parsers/comments';
import { VERDICT_OUTCOMES } from '../parsers/commits';
import { HOLDOUT_VERDICTS } from '../parsers/metrics';
import type { Db, Row } from '../scripts/lib/db';
import { runMigrations } from '../scripts/migrate';
import { archonDb, migrationFiles as files } from './test-db';

const RUN_ID = '00000000-0000-0000-0000-000000000001';

let db: Db;
let firstRun: string[] = [];
let archonBefore: Row[][] = [];

/**
 * What a migration could change on Archon's tables: columns, indexes, constraints, and triggers
 * other than the projection's.
 */
const archonSchema = (): Promise<Row[][]> =>
  Promise.all([
    db.query(`SELECT table_name, column_name, data_type, is_nullable, column_default
      FROM information_schema.columns WHERE table_schema = 'public'
        AND table_name <> 'mc_schema_migrations' ORDER BY table_name, column_name`),
    db.query(`SELECT tablename, indexname, indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND tablename <> 'mc_schema_migrations' ORDER BY indexname`),
    db.query(`SELECT c.relname, k.conname, pg_get_constraintdef(k.oid) AS def
      FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname <> 'mc_schema_migrations' ORDER BY k.conname`),
    db.query(`SELECT c.relname, t.tgname FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND t.tgname NOT LIKE 'mc_project_%' ORDER BY t.tgname`),
  ]);

beforeAll(async () => {
  db = await archonDb();
  archonBefore = await archonSchema();
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
      'lap_step_attempts',
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

test("adds only the projection's triggers to Archon's schema", async () => {
  const publicTables = (
    await db.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`,
    )
  ).map((row) => row.table_name);
  expect(publicTables).toEqual([
    'mc_schema_migrations',
    'remote_agent_codebases',
    'remote_agent_workflow_events',
    'remote_agent_workflow_runs',
  ]);
  expect(await archonSchema()).toEqual(archonBefore);
  const projection = await db.query(`SELECT c.relname, t.tgname FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid WHERE t.tgname LIKE 'mc_project_%' ORDER BY t.tgname`);
  expect(projection).toEqual([
    { relname: 'remote_agent_workflow_runs', tgname: 'mc_project_run_insert' },
    { relname: 'remote_agent_workflow_runs', tgname: 'mc_project_run_update' },
    { relname: 'remote_agent_workflow_events', tgname: 'mc_project_step_event' },
  ]);
});

/** Compiles only when A and B are the same set of literals. */
type Same<A, B> = [A, B] extends [B, A] ? true : false;
const APP_CHECK_KINDS = ['criterion', 'holdout', 'probe', 'defect'] as const;
const parserUnionsBound: [
  Same<(typeof REVIEW_OUTCOMES)[number], Review['outcome']>,
  Same<(typeof APP_CHECK_KINDS)[number], CheckLine['kind']>,
] = [true, true];

test.each([
  ['reviews_outcome_check', REVIEW_OUTCOMES],
  ['verdicts_verdict_check', VERDICT_OUTCOMES],
  ['holdout_verdicts_verdict_check', HOLDOUT_VERDICTS],
  ['app_check_lines_kind_check', APP_CHECK_KINDS],
])('%s allows exactly the values its parser produces', async (name, values) => {
  expect(parserUnionsBound).toEqual([true, true]);
  const [row] = await db.query(
    `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
     WHERE conname = $1 AND connamespace = 'mc'::regnamespace`,
    [name],
  );
  const allowed = [...String(row?.def).matchAll(/'([^']*)'::text/g)].map((match) => match[1]);
  expect(allowed.sort()).toEqual([...values].sort());
});
