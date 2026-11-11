import { parseArgs } from 'node:util';
import type { StepKind } from '../../parsers/pack';
import { failing, guardedDatabaseUrl, type Main, runCli } from '../lib/cli';
import type { Row, Tx } from '../lib/db';
import { metricRecordsFixture } from './metric-records';

const EVENTS = ['node_started', 'node_completed', 'node_failed'] as const;
type StepEvent = (typeof EVENTS)[number];

const USAGE =
  'usage: bun run fixture:write step [--run <id>] [--step <step id>] [--event node_started|node_completed|node_failed] [--error <text>] | attention --run <id> | label [--label <name>] [--issue <number>] | retriage --issue <number> | metrics | comment | issue | pin | verdict [--pin <sha prefix>] | decision';

export const WORKFLOW = 'archon-loop';
export const FACTORY = 'mission-control';
export const REPOSITORY = 'coleam00/factory-mission-control';
const FIXTURE_DIGEST = `sha256:${'f1'.repeat(32)}`;
const HEAD = '3f2c9a1e8b7d6c5a4f3e2d1c0b9a8f7e6d5c4b3a';
const BASE = '845b6201c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8';

/** A literal per loop step that satisfies that node's `output_format` in the pinned pack. */
export function structuredOutputFor(step: string): Record<string, unknown> | undefined {
  switch (step) {
    case 'pick':
      return {
        route: 'complex',
        target: '#3',
        pr: '',
        confidence: 'high',
        depth: 'normal',
        area: 'scripts/fixture/*',
        reason: 'Oldest workable item; its dependency #1 is closed.',
      };
    case 'check-app':
      return {
        pr: '#29',
        head: HEAD,
        merged_with: BASE,
        lines: [
          {
            id: '1',
            kind: 'criterion',
            verdict: 'PASS',
            text: 'fixture:drop deletes exactly check-old and check-abc',
            evidence: ['check-app/drop-test.txt'],
            pre_existing: '',
            defect: '',
            carried_from: '',
          },
          {
            id: '2',
            kind: 'holdout',
            verdict: 'PASS',
            text: 'H-03',
            evidence: ['check-app/holdout-H-03.txt'],
            pre_existing: '',
            defect: '',
            carried_from: '',
          },
          {
            id: '3',
            kind: 'probe',
            verdict: 'OK',
            text: 'GET /api/health returns 200 on port 8851',
            evidence: ['check-app/health.txt'],
            pre_existing: '',
            defect: '',
            carried_from: '',
          },
        ],
        noticed: [],
        overall: 'PASS',
        summary: 'Every criterion and the holdout pass on the merged head.',
      };
    case 'review':
      return {
        outcome: 'merge',
        pr: '#29',
        sha: HEAD,
        delivers: 'all',
        dispositions: [],
        judge_changes: [],
        reason: 'The app check passed with evidence and the diff matches the issue.',
      };
    case 'land':
      return { outcome: 'merged', reason: `Merged ${HEAD.slice(0, 7)} into main.` };
    default:
      return undefined;
  }
}

/** The loop's node kinds: `land` is a script, the others name a command file. */
const COMMANDS: Record<string, string> = {
  pick: 'loop-pick',
  'check-app': 'loop-check-app',
  review: 'loop-review',
};

/** The node block every event of a step carries in `data`; only a command node runs a model. */
export function nodeBlock(step: string, kind: StepKind, command: string): Record<string, unknown> {
  const isCommand = kind === 'command';
  return {
    node: { id: step, kind, source: { kind: 'project' } },
    type: kind,
    command: isCommand ? command : null,
    accounting: 'node',
    ...(isCommand ? { tier: 'medium', model: 'sonnet', provider: 'claude' } : {}),
  };
}

/**
 * The keys Archon's executor writes into `data` for a node event, with fixture values. `error` is a
 * failed event's error text.
 */
export function eventData(
  step: string,
  event: StepEvent,
  now: Date,
  error = `${step} failed: fixture error`,
): Record<string, unknown> {
  const isScript = step === 'land';
  const startedAt = new Date(now.getTime() - 184_250).toISOString();
  const node = nodeBlock(step, isScript ? 'script' : 'command', COMMANDS[step] ?? step);
  if (event === 'node_started') return { ...node, timing: { startedAt } };
  if (event === 'node_failed') {
    return {
      ...node,
      timing: { startedAt, durationMs: 18_400 },
      duration_ms: 18_400,
      error,
    };
  }
  const output = structuredOutputFor(step);
  const tokens = { input: 48_210, output: 6_904, cacheRead: 39_877, cacheWrite: 8_333 };
  return {
    ...node,
    timing: { startedAt, durationMs: 184_250 },
    duration_ms: 184_250,
    ...(isScript ? {} : { tokens, cost_usd: 0.4213, num_turns: 14 }),
    node_output: output === undefined ? 'Done.' : JSON.stringify(output),
    ...(output === undefined
      ? {}
      : { structured_output: output, declared_fields: Object.keys(output) }),
  };
}

/**
 * Archon's rows hold jsonb objects: an insert passes the object (how a jsonb parameter binds is on
 * `Tx.query` in ../lib/db) and returns `jsonb_typeof` of what Postgres stored as `stored`; this
 * throws unless it is an object, so a write in a transaction rolls back.
 */
export function requireObject(what: string, row: Row | undefined): void {
  if (row?.stored !== 'object') {
    throw new Error(`${what} was stored as a jsonb ${row?.stored ?? 'nothing'}, not an object`);
  }
}

async function runningRunId(db: Tx): Promise<string> {
  const [running] = await db.query(
    `SELECT id FROM remote_agent_workflow_runs WHERE workflow_name = $1 AND status = 'running' ORDER BY started_at DESC LIMIT 1`,
    [WORKFLOW],
  );
  if (running) return String(running.id);
  const [created] = await db.query(
    `INSERT INTO remote_agent_workflow_runs (workflow_name, status, user_message, metadata) VALUES ($1, 'running', $2, $3::jsonb) RETURNING id, jsonb_typeof(metadata) AS stored`,
    [WORKFLOW, `Run the loop on ${REPOSITORY}`, { workflow_source: { digest: FIXTURE_DIGEST } }],
  );
  requireObject('the run metadata', created);
  return String(created.id);
}

async function eventCount(db: Tx, runId: string): Promise<number> {
  const [row] = await db.query(
    'SELECT count(*)::int AS n FROM remote_agent_workflow_events WHERE workflow_run_id = $1',
    [runId],
  );
  return Number(row.n);
}

/** What a row kind can be told besides the time: the pin a verdict judges, the label `label` writes and the issue it writes it on. */
type RowOptions = { pin?: string; label?: string; issue?: number };

/** A dashboard row a kind inserts, its values taken from the moment it runs so writes never collide. */
type RowKind = {
  table: string;
  insert: (at: Date, options: RowOptions) => { sql: string; params: unknown[] };
  /** What the insert must find on the branch, for a kind whose row is chosen from others. */
  needs?: string;
};

/** The issue `label` labels next: the factory's highest-numbered open one without needs-owner. */
export const NEXT_TO_LABEL = `SELECT i.factory, i.number FROM mc.issues i
  WHERE i.factory = $1::text AND i.state = 'open'
    AND NOT EXISTS (SELECT 1 FROM mc.issue_labels l
    WHERE l.factory = i.factory AND l.issue_number = i.number AND l.label = 'needs-owner')
  ORDER BY i.number DESC LIMIT 1`;

const sha1 = (text: string) => new Bun.CryptoHasher('sha1').update(text).digest('hex');

const ROW_KINDS = {
  issue: {
    table: 'mc.issues',
    insert: (at) => ({
      sql: `INSERT INTO mc.issues (factory, number, title, state, phase, url, created_at, updated_at)
        SELECT $1::text, next.n, $2::text, 'open', 'Screens', $3::text || next.n,
          $4::timestamptz, $4::timestamptz
        FROM (SELECT coalesce(max(number), 0) + 1 AS n FROM mc.issues WHERE factory = $1::text) next
        RETURNING number`,
      params: [
        FACTORY,
        `Fixture issue written at ${at.toISOString()}`,
        `https://github.com/${REPOSITORY}/issues/`,
        at.toISOString(),
      ],
    }),
  },
  label: {
    table: 'mc.issue_labels',
    needs: `the issue --issue names, or else an open ${FACTORY} issue without needs-owner`,
    insert: (at, { label = 'needs-owner', issue }) => ({
      sql: `INSERT INTO mc.issue_labels (factory, issue_number, label, labeled_at)
        SELECT next.factory, next.number, $3::text, $2::timestamptz FROM (${
          issue === undefined
            ? NEXT_TO_LABEL
            : 'SELECT factory, number FROM mc.issues WHERE factory = $1::text AND number = $4::int'
        }) next
        RETURNING issue_number`,
      params:
        issue === undefined
          ? [FACTORY, at.toISOString(), label]
          : [FACTORY, at.toISOString(), label, issue],
    }),
  },
  comment: {
    table: 'mc.comments',
    needs: `a ${FACTORY} issue`,
    insert: (at) => ({
      sql: `INSERT INTO mc.comments (factory, id, issue_number, author, url, created_at, updated_at)
        SELECT i.factory, $2::bigint, i.number, 'coleam00', i.url || '#issuecomment-' || $2::text,
          $3::timestamptz, $3::timestamptz
        FROM mc.issues i WHERE i.factory = $1::text ORDER BY i.number DESC LIMIT 1
        RETURNING id`,
      params: [FACTORY, String(at.getTime()), at.toISOString()],
    }),
  },
  pin: {
    table: 'mc.pins',
    insert: (at) => ({
      sql: `INSERT INTO mc.pins (sha, archon_sha, reason, hypothesis, measure, committed_at)
        VALUES ($1::text, $2::text, $3::text, $4::text, $5::text, $6::timestamptz) RETURNING sha`,
      params: [
        sha1(`pin ${at.toISOString()}`),
        sha1(`archon ${at.toISOString()}`),
        `fixture pin written at ${at.toISOString()}`,
        'complex laps finish faster.',
        'complex-route lap-hours per merge over 10 laps.',
        at.toISOString(),
      ],
    }),
  },
  verdict: {
    table: 'mc.verdicts',
    needs: 'a pin to judge (the latest, or the one --pin names by prefix)',
    insert: (at, { pin }) => ({
      sql: `INSERT INTO mc.verdicts (sha, pin, verdict, sentence, committed_at)
        SELECT $1::text, left(p.sha, 8), 'inconclusive', $2::text, $3::timestamptz
        FROM mc.pins p WHERE $4::text IS NULL OR p.sha LIKE $4::text || '%'
        ORDER BY p.committed_at DESC LIMIT 1
        RETURNING sha`,
      params: [
        sha1(`verdict ${at.toISOString()}`),
        'Too few laps since the pin to tell.',
        at.toISOString(),
        pin ?? null,
      ],
    }),
  },
  decision: {
    table: 'mc.decisions',
    insert: (at) => ({
      sql: `INSERT INTO mc.decisions (date, title, decision, why, replaces, version)
        SELECT $1::date, $2::text, 'Keep the fixture decision.', 'It proves the timeline is live.',
          'nothing',
          coalesce((SELECT left(sha, 8) FROM mc.pins ORDER BY committed_at DESC LIMIT 1), 'none')
        RETURNING title`,
      params: [at.toISOString().slice(0, 10), `Fixture decision ${at.toISOString()}`],
    }),
  },
} satisfies Record<string, RowKind>;

export type RowKindName = keyof typeof ROW_KINDS;

const isRowKind = (kind: string): kind is RowKindName => Object.hasOwn(ROW_KINDS, kind);

async function rowCount(tx: Tx, table: string): Promise<number> {
  const [row] = await tx.query(`SELECT count(*)::int AS n FROM ${table}`);
  return Number(row?.n);
}

/**
 * Inserts one row of `name`, and fails unless its table holds exactly one more row. `pin` is a sha
 * prefix naming the pin a verdict judges; without it a verdict judges the latest pin. `label` is
 * the label `label` writes, `needs-owner` without it, on `issue` or else the next issue to label.
 */
export async function writeRow(
  tx: Tx,
  name: RowKindName,
  at: Date,
  options: RowOptions = {},
): Promise<string> {
  const kind: RowKind = ROW_KINDS[name];
  const before = await rowCount(tx, kind.table);
  const { sql, params } = kind.insert(at, options);
  await tx.query(sql, params);
  const after = await rowCount(tx, kind.table);
  const report = `${kind.table} rows: ${before} -> ${after}`;
  if (after !== before + 1) {
    throw new Error(`${report}, not one more${kind.needs ? `: ${name} needs ${kind.needs}` : ''}`);
  }
  return report;
}

async function writeEvent(tx: Tx, { step, event, run, error }: StepCli, at: Date): Promise<string> {
  const runId = run ?? (await runningRunId(tx));
  const before = await eventCount(tx, runId);
  const [inserted] = await tx.query(
    'INSERT INTO remote_agent_workflow_events (workflow_run_id, event_type, step_name, data) VALUES ($1, $2, $3, $4::jsonb) RETURNING jsonb_typeof(data) AS stored',
    [runId, event, step, eventData(step, event, at, error)],
  );
  requireObject('the event data', inserted);
  return `events for run ${runId}: ${before} -> ${await eventCount(tx, runId)}`;
}

/** The wait Archon writes on a run paused at an attention node, as `metadata.wait`. */
export function attentionWait(waitingSince: string): Record<string, unknown> {
  return {
    owner: 'node',
    nodeId: 'ask',
    kind: 'attention',
    waitingSince,
    message: 'Fixture question',
    pauseId: '5eedaaaa-0000-4000-8000-000000000001',
  };
}

/** Pauses one running run on an open attention wait, as Archon does; fails unless exactly one run changed. */
async function pauseOnAttention(tx: Tx, runId: string, at: Date): Promise<string> {
  const changed = await tx.query(
    `UPDATE remote_agent_workflow_runs
       SET status = 'paused', metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{wait}', $2::jsonb)
     WHERE id = $1 AND status = 'running' RETURNING id`,
    [runId, attentionWait(at.toISOString())],
  );
  if (changed.length !== 1)
    throw new Error(`run ${runId} is not a running run, so it cannot be paused`);
  return `run ${runId}: running -> paused on attention`;
}

/**
 * Marks a re-triage of a work item in its state row, as the intake queue does to the item's
 * work/<n> document, and bumps the revision; fails unless exactly one row changed.
 */
async function retriage(tx: Tx, issue: number, at: Date): Promise<string> {
  const changed = await tx.query(
    `UPDATE mc.work_item_states SET triage_at = $2, revision = revision + 1
     WHERE number = $1 RETURNING number`,
    [issue, at.toISOString()],
  );
  if (changed.length !== 1)
    throw new Error(
      `${changed.length} work item states for #${issue}, not one, so it was not re-triaged`,
    );
  return `work item #${issue}: re-triaged`;
}

/**
 * Writes one completed `archon-metrics-prs` run on the factory's codebase, its `prs` node carrying
 * the records of metricRecordsFixture, as Archon does; the projection trigger fills mc.metric_records.
 * Fails unless a row was added.
 */
export async function writeMetrics(tx: Tx, at: Date): Promise<string> {
  const before = await rowCount(tx, 'mc.metric_records');
  const [run] = await tx.query(
    `INSERT INTO remote_agent_workflow_runs
       (workflow_name, codebase_id, status, user_message, started_at, completed_at)
     SELECT 'archon-metrics-prs', c.id, 'completed', $2::text, $3::timestamptz, $3::timestamptz
     FROM remote_agent_codebases c WHERE c.name = $1 RETURNING id`,
    [REPOSITORY, `Record the SDLC metrics of ${REPOSITORY}`, at.toISOString()],
  );
  if (!run) throw new Error(`no codebase named ${REPOSITORY}, so no metrics run was written`);
  for (const event of ['node_started', 'node_completed'] as const) {
    const [inserted] = await tx.query(
      `INSERT INTO remote_agent_workflow_events (workflow_run_id, event_type, step_name, data)
       VALUES ($1, $2, 'prs', $3::jsonb) RETURNING jsonb_typeof(data) AS stored`,
      [
        run.id,
        event,
        {
          type: 'script',
          ...(event === 'node_completed' && {
            structured_output: { metrics: metricRecordsFixture(at) },
          }),
        },
      ],
    );
    requireObject('the event data', inserted);
  }
  const after = await rowCount(tx, 'mc.metric_records');
  const report = `mc.metric_records rows: ${before} -> ${after}`;
  if (after <= before) throw new Error(`${report}, none added`);
  return report;
}

export const main: Main = async (argv, deps) => {
  let parsed: Cli;
  try {
    parsed = parseCli(argv);
  } catch (error) {
    deps.err(error instanceof Error ? `${error.message}\n${USAGE}` : USAGE);
    return 2;
  }
  return failing(deps, async () => {
    const db = deps.openDb(await guardedDatabaseUrl(deps, 'check'));
    try {
      let report = '';
      await db.transaction(async (tx) => {
        if (parsed.kind === 'step') report = await writeEvent(tx, parsed, deps.now());
        else if (parsed.kind === 'attention')
          report = await pauseOnAttention(tx, parsed.run, deps.now());
        else if (parsed.kind === 'retriage') report = await retriage(tx, parsed.issue, deps.now());
        else if (parsed.kind === 'metrics') report = await writeMetrics(tx, deps.now());
        else report = await writeRow(tx, parsed.kind, deps.now(), parsed);
      });
      deps.out(report);
    } finally {
      await db.close();
    }
  });
};

type StepCli = { kind: 'step'; step: string; event: StepEvent; run?: string; error?: string };
type AttentionCli = { kind: 'attention'; run: string };
type RetriageCli = { kind: 'retriage'; issue: number };
type MetricsCli = { kind: 'metrics' };
type Cli = StepCli | AttentionCli | RetriageCli | MetricsCli | ({ kind: RowKindName } & RowOptions);

function parseCli(argv: string[]): Cli {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      run: { type: 'string' },
      step: { type: 'string' },
      event: { type: 'string' },
      pin: { type: 'string' },
      label: { type: 'string' },
      issue: { type: 'string' },
      error: { type: 'string' },
    },
  });
  const [kind, ...extra] = positionals;
  if (kind === undefined || extra.length > 0) throw new Error('name exactly one kind');
  if (kind === 'attention') {
    const { run, ...others } = values;
    if (run === undefined) throw new Error('attention needs --run <id>');
    if (Object.keys(others).length > 0) throw new Error('attention takes only --run');
    return { kind, run };
  }
  if (kind === 'retriage') {
    const { issue, ...others } = values;
    if (issue === undefined || !/^[1-9][0-9]*$/.test(issue))
      throw new Error('retriage needs --issue <number>');
    if (Object.keys(others).length > 0) throw new Error('retriage takes only --issue');
    return { kind, issue: Number(issue) };
  }
  if (kind === 'metrics') {
    if (Object.keys(values).length > 0) throw new Error('metrics takes no option');
    return { kind };
  }
  if (isRowKind(kind)) {
    const { pin, label, issue: issueText, ...stepOnly } = values;
    if (Object.keys(stepOnly).length > 0) {
      throw new Error('--run, --step, --event and --error are for step');
    }
    if (label !== undefined) {
      if (kind !== 'label') throw new Error('--label is for label');
      if (label === '' || label !== label.trim()) {
        throw new Error('--label takes a name with no leading or trailing space');
      }
    }
    if (issueText !== undefined) {
      if (kind !== 'label') throw new Error('--issue is for label');
      if (!/^[1-9][0-9]*$/.test(issueText))
        throw new Error(`--issue takes an issue number, not ${issueText}`);
    }
    if (pin !== undefined) {
      if (kind !== 'verdict') throw new Error('--pin is for verdict');
      if (!/^[0-9a-f]{4,40}$/.test(pin)) throw new Error(`--pin takes a sha prefix, not ${pin}`);
    }
    return {
      kind,
      ...(pin !== undefined && { pin }),
      ...(label !== undefined && { label }),
      ...(issueText !== undefined && { issue: Number(issueText) }),
    };
  }
  if (values.pin !== undefined) throw new Error('--pin is for verdict');
  if (values.label !== undefined) throw new Error('--label is for label');
  if (values.issue !== undefined) throw new Error('--issue is for label');
  if (kind !== 'step') throw new Error(`unknown kind ${kind}`);
  const event = EVENTS.find((name) => name === (values.event ?? 'node_completed'));
  if (!event) throw new Error(`unknown event ${values.event}`);
  if (values.error !== undefined && event !== 'node_failed') {
    throw new Error('--error is for --event node_failed');
  }
  return { kind, step: values.step ?? 'pick', event, run: values.run, error: values.error };
}

if (import.meta.main) await runCli(main);
