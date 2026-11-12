import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { StatusStripRow } from '../app/components/FactoryStrip';
import type { FactorySwitcherRow } from '../app/components/FactorySwitcher';
import type { AppCheckRow } from '../app/lib/app-check';
import type { ArchDiffRow } from '../app/lib/arch-diff';
import type { AttentionRow, DecideRow, UnstickRow } from '../app/lib/attention';
import type { SweepRow } from '../app/lib/attention-page';
import type { BoardRow, DiscoveryRow } from '../app/lib/board';
import type { FactoryScorecardRow } from '../app/lib/factory-scorecard';
import type { FailureGroupRow, RetriedRunRow } from '../app/lib/failures';
import type { HealthRunRow, HealthStepRow, HealthWorkableRow } from '../app/lib/health';
import type { LapMapRow } from '../app/lib/lap-graph';
import type { HandledRow } from '../app/lib/manager';
import type { CheckLineRow, OneLapRow, StepAttemptRow } from '../app/lib/one-lap';
import type { OwnerQueueRow } from '../app/lib/owner-queue';
import type { RewindBranchRow } from '../app/lib/rewind';
import type { RunsRow } from '../app/lib/runs';
import type { ScorecardRow } from '../app/lib/scorecard';
import type {
  NestingRow,
  PartRow,
  StepRow,
  StepVersionRow,
  SubagentRow,
  YamlPartRow,
} from '../app/lib/step-detail';
import type { VersionStripRow } from '../app/lib/version-strip';
import type { WorkItemRow } from '../app/lib/work-item';
import type { HomeMapRow, MapRightNowRow, ProductDocumentRow, WorkOrderRow } from '../app/map/live';
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
  'app-check': columns<AppCheckRow>()([
    'number',
    'title',
    'url',
    'run_id',
    'overall',
    'criteria',
    'probes',
    'assertions',
  ]),
  'arch-diff': columns<ArchDiffRow>()(['digest', 'kind', 'workflow', 'first_run_at', 'entries']),
  'attention-items': columns<AttentionRow>()([
    'run_id',
    'workflow_name',
    'node_id',
    'waiting_since',
    'form',
    'options',
    'labels',
    'recommended',
    'message',
    'console',
  ]),
  'factory-scorecard': columns<FactoryScorecardRow>()([
    'name',
    'kind',
    'unit',
    'value_7',
    'n_7',
    'value_7_before',
    'n_7_before',
    'value_30',
    'n_30',
    'value_30_before',
    'n_30_before',
  ]),
  'failure-groups': columns<FailureGroupRow>()([
    'signature',
    'workflow_name',
    'step_id',
    'class',
    'failures',
    'first_at',
    'last_at',
    'latest_run_id',
    'line',
    'last_day',
    'daily',
    'console',
  ]),
  'retried-runs': columns<RetriedRunRow>()([
    'run_id',
    'workflow_name',
    'step_id',
    'line',
    'stopped_at',
  ]),
  decide: columns<DecideRow>()([
    'run_id',
    'workflow_name',
    'node_id',
    'occurrence_id',
    'waiting_since',
    'form',
    'options',
    'labels',
    'recommended',
    'confidence',
    'recommendation_why',
    'item_number',
    'item_title',
    'message',
    'console',
  ]),
  unstick: columns<UnstickRow>()([
    'kind',
    'number',
    'run_id',
    'workflow_name',
    'waits_on',
    'since',
    'action',
    'title',
    'blocker_titles',
    'reason',
    'console',
  ]),
  handled: columns<HandledRow>()([
    'id',
    'action',
    'run_id',
    'option',
    'from_step',
    'sent_at',
    'exit_code',
    'workflow_name',
  ]),
  'manager-sweep': columns<SweepRow>()(['swept_at']),
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
  'work-item': columns<WorkItemRow>()([
    'kind',
    'run_id',
    'workflow',
    'status',
    'started_at',
    'completed_at',
    'lap',
    'waiting',
    'cost',
    'steps',
    'failed_step',
    'error',
    'route',
    'depth',
    'labels',
    'deliveries',
    'review',
    'review_at',
    'rereview',
    'rereview_at',
    'check_overall',
    'check_at',
    'decision',
    'reason',
    'decision_at',
    'answer',
    'answer_summary',
    'answer_at',
    'line_kind',
    'line_verdict',
    'pr',
    'decisions',
    'landed',
    'asked_pr',
    'record_status',
    'number',
    'title',
    'url',
    'console',
    'stop_step',
    'stop_line',
    'stop_class',
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
    'build_status',
    'build_at',
    'merge_status',
    'merge_at',
    'triage_at',
    'stage',
    'repository',
    'merged_total',
  ]),
  discoveries: columns<DiscoveryRow>()(['run_id', 'written', 'dropped']),
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
  'one-lap-checks': columns<CheckLineRow>()([
    'position',
    'line_id',
    'kind',
    'verdict',
    'evidence_count',
  ]),
  'one-lap-map': columns<LapMapRow>()([
    'pin',
    'archon_sha',
    'path',
    'parent_path',
    'position',
    'step_id',
    'kind',
    'depends_on',
    'when_condition',
    'trigger_rule',
    'round_cap',
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
    'event_at',
  ]),
  'one-lap': columns<OneLapRow>()([
    'run_id',
    'workflow_name',
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
    'pr_number',
    'review_status',
    'review_outcome',
    'review_delivers',
    'dispositions',
    'hidden_lines',
    'gate_status',
    'gate_outcome',
    'gate_reason',
    'stop_status',
    'stop_step',
    'stop_line',
    'stop_class',
    'capacity_since',
    'pr_state',
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
  runs: columns<RunsRow>()([
    'all_count',
    'running_count',
    'needs_you_count',
    'failed_count',
    'done_count',
    'idle_count',
    'idle_polls',
    'run_id',
    'position',
    'workflow_name',
    'status',
    'state',
    'idle_poll',
    'started_at',
    'completed_at',
    'issue_number',
    'issue_title',
    'stop_step',
    'stop_line',
    'round',
    'step_id',
    'pr_number',
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
  'status-strip': columns<StatusStripRow>()(['running', 'waiting', 'engine']),
  'step-detail': columns<StepRow>()([
    'pin',
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
    'child_workflow',
    'command_file',
    'script',
    'script_file',
    'runtime',
    'bash',
    'prompt',
    'defined_in',
    'file',
  ]),
  'step-nesting': columns<NestingRow>()(['path', 'position', 'step_id', 'kind']),
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
  'map-right-now': columns<MapRightNowRow>()([
    'kind',
    'run_id',
    'at',
    'decisions',
    'merged',
    'asked',
    'claimed',
    'revision',
    'health',
    'status',
    'repository',
  ]),
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

/** Set-returning functions; Realtime refuses them as a query source (REALTIME.md). */
const SET_RETURNING =
  /\b(generate_series|generate_subscripts|unnest|jsonb?_array_elements(_text)?|jsonb?_each(_text)?|jsonb?_object_keys|jsonb?_to_recordset|jsonb?_populate_recordset|jsonb?_path_query(_array)?|regexp_matches|regexp_split_to_table|string_to_table|json_table|pg_ls_dir|pg_stat_get_activity|pg_show_all_settings)\s*\(/i;

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

  test('calls no set-returning function', () => {
    expect(sql).not.toMatch(SET_RETURNING);
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
  const ON_THE_QUEUES = "IN ('archon-intake', 'archon-build-queue')";

  const LAP =
    /workflow_name = 'archon-loop' OR l\.workflow_name = 'archon-build-queue' AND EXISTS \(\s*SELECT 1 FROM mc\.lap_steps f WHERE f\.run_id = l\.run_id AND f\.step_id = 'facts'\s*AND f\.output -> 'item' ->> 'number' IS NOT NULL\)/g;
  const count = (sql: string, part: string | RegExp) =>
    typeof part === 'string' ? sql.split(part).length - 1 : (sql.match(part) ?? []).length;

  test('no live query takes a step pr or pr_url from its output, they read the projected pr_number', () => {
    // app-check.sql tests `->> 'pr' IS NOT NULL` only to choose which step's pr_number to use.
    for (const [name, sql] of queries) {
      expect(sql, name).not.toMatch(/->>\s*'pr(_url)?'(?!\s+IS NOT NULL)/);
    }
  });

  test('what dates a version is the one list mc.dates_version holds', () => {
    expect(read('db/migrations', '0022_queue_versions.sql')).toContain(DATES_VERSION);
    for (const name of ['version-strip', 'arch-diff']) {
      expect(query(name)).toContain(DATES_VERSION);
    }
  });

  test('every mention of build-queue in a live query is one of the three rules, none a stray copy', () => {
    // [mc.dates_version copies, lap-rule copies, queues-rule copies, other mentions] per name; a live query
    // not listed here may mention none of them.
    const expected: Record<string, [number, number, number, number?]> = {
      'version-strip': [1, 0, 0],
      'arch-diff': [2, 0, 0],
      scorecard: [0, 2, 0],
      // The same list as mc.dates_version: the lap a work order's row names is one that ran a version.
      board: [1, 0, 0],
      // The queues rule asks which intake or build-queue runs exist, not what dates a version.
      'home-map': [0, 0, 1],
      // Exception: the lap rule narrowed to one item ($2) rather than any item, and the route join that
      // reads a build-queue run's own routing step.
      'work-item': [0, 0, 0, 2],
      'one-lap-map': [0, 0, 1],
      'one-lap-steps': [0, 0, 1],
      'step-detail': [0, 0, 1],
      'step-nesting': [0, 0, 1],
      'step-prompt': [0, 0, 1],
      'step-scripts': [0, 0, 1],
      'step-subagents': [0, 0, 1],
      'step-yaml': [0, 0, 1],
      'step-versions': [0, 0, 1],
      'status-strip': [0, 0, 1],
    };
    const copies = [...queries];
    for (const [name, sql] of copies) {
      const [datesVersion, lap, queues, other = 0] = expected[name] ?? [0, 0, 0];
      expect([name, count(sql, DATES_VERSION), count(sql, LAP)]).toEqual([name, datesVersion, lap]);
      expect([name, count(sql, ON_THE_QUEUES)]).toEqual([name, queues]);
      expect([name, count(sql, "'archon-build-queue'")]).toEqual([
        name,
        datesVersion + lap + queues + other,
      ]);
    }
  });

  test('merged is closed, not as not planned or a duplicate, with a merged pull request that closes or Refs it, in every copy', () => {
    const NOT_DELIVERED =
      /i\.state = 'closed'\s+AND coalesce\(i\.close_reason, 'completed'\) NOT IN \('not_planned', 'duplicate'\)/g;
    // The delivery branches as one predicate: a merged PR that closes the item, or one that Refs it.
    const DELIVERED =
      /AND \(EXISTS \(\s*SELECT 1 FROM mc\.pull_request_issues pi\s+JOIN mc\.pull_requests p ON p\.factory = pi\.factory AND p\.number = pi\.pr_number\s+WHERE pi\.factory = i\.factory AND pi\.issue_number = i\.number AND p\.merged_at IS NOT NULL\s*\) OR EXISTS \(\s*SELECT 1 FROM mc\.pull_request_references rf\s+JOIN mc\.pull_requests p ON p\.factory = rf\.factory AND p\.number = rf\.pr_number\s+WHERE rf\.factory = i\.factory AND rf\.issue_number = i\.number AND p\.merged_at IS NOT NULL\s*\)\)/g;
    // The closing branch alone, so a copy in the pre-Refs form is counted too.
    const BY_CLOSING = 'pi.issue_number = i.number AND p.merged_at IS NOT NULL';
    // [copies] per name; a live query not listed here may state the rule nowhere.
    const copies: Record<string, number> = {
      board: 2,
      'work-orders': 1,
      'product-documents': 1,
    };
    for (const [name, sql] of queries) {
      const expected = copies[name] ?? 0;
      expect([
        name,
        count(sql, NOT_DELIVERED),
        count(sql, DELIVERED),
        count(sql, BY_CLOSING),
      ]).toEqual([name, expected, expected, expected]);
    }
  });

  test('a build-queue lap is a run whose facts step names an item, in every copy of the rule', () => {
    for (const sql of [
      query('scorecard'),
      query('work-item'),
      read('fixtures', 'expected-scorecard.sql'),
    ]) {
      expect(sql).toContain("f.step_id = 'facts'");
      expect(sql).toContain("-> 'item' ->> 'number'");
    }
  });

  test('no one-lap query names a workflow: each follows the run it is asked about', () => {
    const names = queries.map(([n]) => n).filter((n) => n.startsWith('one-lap'));
    expect(names.sort()).toEqual(['one-lap', 'one-lap-checks', 'one-lap-map', 'one-lap-steps']);
    for (const name of names) {
      const sql = query(name);
      expect([name, [...sql.matchAll(/workflow(_name)? = '/g)]]).toEqual([name, []]);
      // The queues CTE is step-detail's rule, copied and held equal by version-rule.test.ts.
      const queueGate = sql.replace(/queues AS \([\s\S]*?\) AS on_queues\s*\),/, '');
      expect([name, [...queueGate.matchAll(/'archon-[a-z-]+'/g)]]).toEqual([name, []]);
    }
    for (const name of ['one-lap-map', 'one-lap-steps']) {
      expect([
        name,
        /workflow_name = s\.workflow|s\.workflow = v\.workflow_name/.test(query(name)),
      ]).toEqual([name, true]);
    }
  });
});
