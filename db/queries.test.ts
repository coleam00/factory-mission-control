import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { StatusStripRow } from '../app/components/FactoryStrip';
import type { FactorySwitcherRow } from '../app/components/FactorySwitcher';
import type { ArchDiffRow } from '../app/lib/arch-diff';
import type { AttentionRow } from '../app/lib/attention';
import type { BoardRow } from '../app/lib/board';
import type { LedgerRow, TimelineRow } from '../app/lib/decisions-ledger';
import type { HealthRunRow, HealthStepRow, HealthWorkableRow } from '../app/lib/health';
import type { IssueGraphRow } from '../app/lib/issue-graph';
import type { LapMapRow } from '../app/lib/lap-graph';
import type { LaneRow, RecentLapRow } from '../app/lib/laps';
import type { CheckLineRow, OneLapRow, StepAttemptRow } from '../app/lib/one-lap';
import type { OwnerQueueRow } from '../app/lib/owner-queue';
import type { RewindBranchRow } from '../app/lib/rewind';
import type { ScorecardRow } from '../app/lib/scorecard';
import type {
  NestingRow,
  PartRow,
  StepRow,
  StepVersionRow,
  SubagentRow,
  YamlPartRow,
} from '../app/lib/step-detail';
import type { CheckRow, DefaultHoldoutRow, RouteRow } from '../app/lib/testing';
import type { VersionStripRow } from '../app/lib/version-strip';
import type { HomeMapRow, ProductDocumentRow, WorkOrderRow } from '../app/map/live';
import { LIVE_QUERY_NAME, parameterCount } from '../server/live';
import { migratedDb, paramsFor, queries } from './queries/test-seed';
import type { TestDb } from './test-db';

const dir = join(import.meta.dir, 'queries');

/** Every key any member of a union row has. */
type Keys<Row> = Row extends unknown ? keyof Row & string : never;
/** The listed columns, when they are exactly the row's keys; otherwise a type that names the gap. */
const columns =
  <Row>() =>
  <const C extends readonly Keys<Row>[]>(
    list: C &
      ([Exclude<Keys<Row>, C[number]>] extends [never]
        ? unknown
        : { missing: Exclude<Keys<Row>, C[number]> }),
  ): string[] => [...list];

/** Each live query's result columns, in order, bound to the row type its panel reads. */
const ROW_COLUMNS: Record<string, string[]> = {
  'arch-diff': columns<ArchDiffRow>()(['digest', 'kind', 'workflow', 'first_run_at', 'entries']),
  'attention-items': columns<AttentionRow>()([
    'run_id',
    'workflow_name',
    'node_id',
    'waiting_since',
    'form',
    'options',
    'labels',
    'message',
    'console',
  ]),
  'decisions-timeline': columns<TimelineRow>()([
    'date',
    'title',
    'decision',
    'why',
    'replaces',
    'version',
    'pin_sha',
    'ambiguous',
    'digest',
  ]),
  'factory-switcher': columns<FactorySwitcherRow>()(['factory', 'running', 'is_default']),
  'health-runs': columns<HealthRunRow>()([
    'run_id',
    'workflow_name',
    'status',
    'started_at',
    'completed_at',
    'failed_step',
    'error',
    'failed_at',
    'console',
  ]),
  'health-steps': columns<HealthStepRow>()([
    'kind',
    'run_id',
    'workflow_name',
    'step_id',
    'at',
    'duration_ms',
    'console',
  ]),
  'health-workable': columns<HealthWorkableRow>()([
    'kind',
    'issue_number',
    'title',
    'url',
    'run_id',
  ]),
  board: columns<BoardRow>()([
    'kind',
    'number',
    'title',
    'url',
    'state',
    'closed_at',
    'work_orders',
    'route',
    'rounds',
    'app_check',
    'pr',
    'pr_open',
    'run_id',
    'run_workflow',
    'repository',
    'console',
    'merged_total',
  ]),
  'home-map': columns<HomeMapRow>()([
    'kind',
    'run_id',
    'workflow',
    'steps',
    'number',
    'title',
    'url',
    'at',
    'prs',
  ]),
  'improvements-ledger': columns<LedgerRow>()([
    'pin_sha',
    'reason',
    'measure',
    'committed_at',
    'laps',
    'verdict',
    'sentence',
    'verdict_at',
    'pin_matches',
  ]),
  'issue-graph': columns<IssueGraphRow>()([
    'kind',
    'number',
    'title',
    'phase',
    'url',
    'state',
    'depends_on',
  ]),
  lanes: columns<LaneRow>()([
    'run_id',
    'started_at',
    'issue_number',
    'issue_title',
    'issue_url',
    'route',
    'depth',
    'step_id',
    'step_started_at',
    'cost_usd',
    'steps',
  ]),
  'one-lap-checks': columns<CheckLineRow>()([
    'position',
    'line_id',
    'kind',
    'verdict',
    'evidence_count',
  ]),
  'one-lap-map': columns<LapMapRow>()([
    'pin',
    'path',
    'parent_path',
    'position',
    'step_id',
    'kind',
    'depends_on',
    'when_condition',
    'trigger_rule',
    'detail_workflow',
    'detail_path',
  ]),
  'one-lap-steps': columns<StepAttemptRow>()([
    'step_id',
    'status',
    'started_at',
    'duration_ms',
    'model',
    'tokens_input',
    'tokens_output',
    'tokens_cache_read',
    'tokens_cache_write',
    'cost_usd',
    'outcome',
    'error',
    'position',
  ]),
  'one-lap': columns<OneLapRow>()([
    'run_id',
    'status',
    'started_at',
    'completed_at',
    'repository',
    'console',
    'issue_number',
    'issue_title',
    'issue_url',
    'route',
    'depth',
    'pr',
    'review_status',
    'review_outcome',
    'review_delivers',
    'dispositions',
    'hidden_lines',
    'gate_status',
    'gate_outcome',
    'gate_reason',
  ]),
  'owner-queue': columns<OwnerQueueRow>()([
    'kind',
    'issue_number',
    'question_number',
    'title',
    'url',
    'options',
    'recommendation',
    'default_option',
    'default_at',
    'waiting_since',
    'approximate',
  ]),
  'recent-laps': columns<RecentLapRow>()([
    'run_id',
    'status',
    'started_at',
    'completed_at',
    'issue_number',
    'outcome',
    'cost_usd',
  ]),
  'rewind-branches': columns<RewindBranchRow>()(['name', 'parent', 'at', 'created_at']),
  scorecard: columns<ScorecardRow>()([
    'run_id',
    'digest',
    'workflow_name',
    'status',
    'started_at',
    'completed_at',
    'step_id',
    'duration_ms',
    'cost_usd',
    'route',
    'outcome',
    'reason',
    'pin_sha',
    'first_run_at',
    'issue',
    'pull_request',
    'merged',
    'items',
  ]),
  'status-strip': columns<StatusStripRow>()(['running']),
  'step-detail': columns<StepRow>()([
    'workflow',
    'path',
    'parent_path',
    'position',
    'step_id',
    'kind',
    'description',
    'model',
    'when_condition',
    'depends_on',
    'trigger_rule',
    'include',
    'command_file',
    'script',
    'script_file',
    'runtime',
    'bash',
    'prompt',
    'defined_in',
    'file',
  ]),
  'step-nesting': columns<NestingRow>()([
    'relation',
    'workflow',
    'path',
    'position',
    'step_id',
    'kind',
    'open_workflow',
    'open_path',
  ]),
  'step-prompt': columns<PartRow>()(['path', 'part', 'chunk']),
  'step-scripts': columns<PartRow>()(['path', 'part', 'chunk']),
  'step-subagents': columns<SubagentRow>()([
    'workflow',
    'step_path',
    'name',
    'description',
    'prompt',
    'instruction_file',
    'part',
    'chunk',
  ]),
  'step-versions': columns<StepVersionRow>()(['sha', 'reason', 'committed_at', 'is_current']),
  'step-yaml': columns<YamlPartRow>()(['name', 'file', 'part', 'chunk']),
  'testing-app-check': columns<CheckRow>()([
    'run_id',
    'position',
    'kind',
    'verdict',
    'scenario_id',
    'started_at',
    'pr',
  ]),
  'testing-holdouts': columns<DefaultHoldoutRow>()([
    'at',
    'sha',
    'report_issue',
    'scenario_id',
    'verdict',
    'issue_number',
    'issue_title',
    'issue_state',
    'issue_url',
    'repository',
  ]),
  'testing-routes': columns<RouteRow>()(['run_id', 'status', 'started_at', 'route', 'depth']),
  'product-documents': columns<ProductDocumentRow>()([
    'number',
    'title',
    'url',
    'total_count',
    'merged_count',
  ]),
  'work-orders': columns<WorkOrderRow>()([
    'name',
    'total_count',
    'open_count',
    'merged_count',
    'lands_on',
    'last_closed_at',
  ]),
  'version-strip': columns<VersionStripRow>()([
    'digest',
    'first_run_at',
    'pin_sha',
    'reason',
    'hypothesis',
    'measure',
    'committed_at',
  ]),
};

/** Functions whose value changes between evaluations; Realtime refuses them (REALTIME.md). */
const VOLATILE =
  /\b(now|random|clock_timestamp|statement_timestamp|transaction_timestamp|timeofday|gen_random_uuid|nextval|current_timestamp|current_date|current_time|localtime|localtimestamp)\b/i;

test('every file in db/queries/ is a live query named for its panel', () => {
  const sqlFiles = readdirSync(dir).filter((f) => f.endsWith('.sql'));
  expect(sqlFiles.length).toBeGreaterThan(0);
  for (const file of sqlFiles) expect(file.slice(0, -4)).toMatch(LIVE_QUERY_NAME);
});

test('every live query has a row type bound to its columns', () => {
  expect(Object.keys(ROW_COLUMNS).sort()).toEqual(queries.map(([name]) => name).sort());
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

  test('calls no function of the mc schema', () => {
    // A user-defined STABLE function is not approved either; #357's mc.version_pin call was refused.
    expect(sql).not.toMatch(/\bmc\.\w+\s*\(/i);
  });

  test("reads the dashboard's own tables, never Archon's", () => {
    expect(sql).not.toMatch(/remote_agent_|provider_event/i);
  });

  test("is keyed by one factory, $1, the home map's and a step panel's by the version too, a lap's by its run id", () => {
    expect(sql).toMatch(/\$1\b/);
    expect(parameterCount(sql)).toBe(paramsFor(name, '').length);
  });
});

describe('against the migrated schema', () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await migratedDb();
  });

  afterAll(() => db.close());

  test.each(queries)('%s runs with a factory name as $1', async (name, sql) => {
    await db.query(sql, paramsFor(name, 'mission-control'));
  });

  test.each(queries)('%s returns the columns its row type names', async (name, sql) => {
    expect(await db.columns(sql, paramsFor(name, 'mission-control'))).toEqual(ROW_COLUMNS[name]);
  });
});

describe('the rules the live queries restate, which they may not call a function for', () => {
  const read = (...path: string[]) => readFileSync(join(import.meta.dir, '..', ...path), 'utf8');
  const query = (name: string) => queries.find(([n]) => n === name)?.[1] as string;
  const DATES_VERSION = "IN ('archon-loop', 'archon-build-queue')";

  const LAP =
    /workflow_name = 'archon-loop' OR l\.workflow_name = 'archon-build-queue' AND EXISTS \(\s*SELECT 1 FROM mc\.lap_steps f WHERE f\.run_id = l\.run_id AND f\.step_id = 'facts'\s*AND f\.output -> 'item' ->> 'number' IS NOT NULL\)/g;
  const count = (sql: string, part: string | RegExp) =>
    typeof part === 'string' ? sql.split(part).length - 1 : (sql.match(part) ?? []).length;

  test('what dates a version is the one list mc.dates_version holds', () => {
    expect(read('db/migrations', '0022_queue_versions.sql')).toContain(DATES_VERSION);
    for (const name of [
      'version-strip',
      'decisions-timeline',
      'arch-diff',
      'improvements-ledger',
    ]) {
      expect(query(name)).toContain(DATES_VERSION);
    }
  });

  test('every mention of build-queue in a live query is one of the two rules, none a stray copy', () => {
    const copies: [string, string, number, number][] = [
      ['version-strip', query('version-strip'), 1, 0],
      ['decisions-timeline', query('decisions-timeline'), 2, 0],
      ['arch-diff', query('arch-diff'), 2, 0],
      ['improvements-ledger', query('improvements-ledger'), 2, 1],
      ['scorecard', query('scorecard'), 0, 2],
      ['live changes oracle', read('scripts', 'live', 'changes.ts'), 0, 1],
      ['live ledger oracle', read('scripts', 'live', 'ledger.ts'), 0, 1],
    ];
    for (const [name, sql, datesVersion, lap] of copies) {
      expect([name, count(sql, DATES_VERSION), count(sql, LAP)]).toEqual([name, datesVersion, lap]);
      expect([name, count(sql, "'archon-build-queue'")]).toEqual([name, datesVersion + lap]);
    }
  });

  test('a build-queue lap is a run whose facts step names an item, in every copy of the rule', () => {
    for (const sql of [
      query('scorecard'),
      query('improvements-ledger'),
      read('fixtures', 'expected-scorecard.sql'),
    ]) {
      expect(sql).toContain("f.step_id = 'facts'");
      expect(sql).toContain("-> 'item' ->> 'number'");
    }
  });
});
