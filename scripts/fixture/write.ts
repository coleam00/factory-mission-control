import { parseArgs } from 'node:util';
import type { StepKind } from '../../parsers/pack';
import { failing, guardedDatabaseUrl, type Main, runCli } from '../lib/cli';
import type { Row, Tx } from '../lib/db';

const EVENTS = ['node_started', 'node_completed', 'node_failed'] as const;
type StepEvent = (typeof EVENTS)[number];

const USAGE =
  'usage: bun run fixture:write step [--run <id>] [--step <step id>] [--event node_started|node_completed|node_failed] | label | comment | issue | pin | verdict [--pin <sha prefix>] | decision';

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

/** The keys Archon's executor writes into `data` for a node event, with fixture values. */
export function eventData(step: string, event: StepEvent, now: Date): Record<string, unknown> {
  const isScript = step === 'land';
  const startedAt = new Date(now.getTime() - 184_250).toISOString();
  const node = nodeBlock(step, isScript ? 'script' : 'command', COMMANDS[step] ?? step);
  if (event === 'node_started') return { ...node, timing: { startedAt } };
  if (event === 'node_failed') {
    return {
      ...node,
      timing: { startedAt, durationMs: 18_400 },
      duration_ms: 18_400,
      error: `${step} failed: fixture error`,
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
 * Archon's rows hold jsonb objects. Bun encodes a string parameter bound to `::jsonb` as a jsonb
 * string, so the insert passes the object and reads back what Postgres stored; a wrong one rolls
 * back.
 */
function requireObject(what: string, row: Row | undefined): void {
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

/** A dashboard row a kind inserts, its values taken from the moment it runs so writes never collide. */
type RowKind = {
  table: string;
  insert: (at: Date, pin?: string) => { sql: string; params: unknown[] };
  /** What the insert must find on the branch, for a kind whose row is chosen from others. */
  needs?: string;
};

/** The issue `label` labels next: the factory's highest-numbered open one without needs-owner. */
export const NEXT_TO_LABEL = `SELECT i.factory, i.number FROM mc.issues i
  WHERE i.factory = $1::text AND i.state = 'open' AND NOT EXISTS (SELECT 1 FROM mc.issue_labels l
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
    needs: `an open ${FACTORY} issue without needs-owner`,
    insert: () => ({
      sql: `INSERT INTO mc.issue_labels (factory, issue_number, label)
        SELECT next.factory, next.number, 'needs-owner' FROM (${NEXT_TO_LABEL}) next
        RETURNING issue_number`,
      params: [FACTORY],
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
      sql: `INSERT INTO mc.pins (sha, archon_sha, reason, hypothesis, measure, committed_at, factory)
        VALUES ($1::text, $2::text, $3::text, $4::text, $5::text, $6::timestamptz, $7::text)
        RETURNING sha`,
      params: [
        sha1(`pin ${at.toISOString()}`),
        sha1(`archon ${at.toISOString()}`),
        `fixture pin written at ${at.toISOString()}`,
        'complex laps finish faster.',
        'complex-route lap-hours per merge over 10 laps.',
        at.toISOString(),
        FACTORY,
      ],
    }),
  },
  verdict: {
    table: 'mc.verdicts',
    needs: 'a pin to judge (the latest, or the one --pin names by prefix)',
    insert: (at, pin) => ({
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
 * prefix naming the pin a verdict judges; without it a verdict judges the latest pin.
 */
export async function writeRow(tx: Tx, name: RowKindName, at: Date, pin?: string): Promise<string> {
  const kind: RowKind = ROW_KINDS[name];
  const before = await rowCount(tx, kind.table);
  const { sql, params } = kind.insert(at, pin);
  await tx.query(sql, params);
  const after = await rowCount(tx, kind.table);
  const report = `${kind.table} rows: ${before} -> ${after}`;
  if (after !== before + 1) {
    throw new Error(`${report}, not one more${kind.needs ? `: ${name} needs ${kind.needs}` : ''}`);
  }
  return report;
}

async function writeEvent(tx: Tx, { step, event, run }: StepCli, at: Date): Promise<string> {
  const runId = run ?? (await runningRunId(tx));
  const before = await eventCount(tx, runId);
  const [inserted] = await tx.query(
    'INSERT INTO remote_agent_workflow_events (workflow_run_id, event_type, step_name, data) VALUES ($1, $2, $3, $4::jsonb) RETURNING jsonb_typeof(data) AS stored',
    [runId, event, step, eventData(step, event, at)],
  );
  requireObject('the event data', inserted);
  return `events for run ${runId}: ${before} -> ${await eventCount(tx, runId)}`;
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
        report =
          parsed.kind === 'step'
            ? await writeEvent(tx, parsed, deps.now())
            : await writeRow(tx, parsed.kind, deps.now(), parsed.pin);
      });
      deps.out(report);
    } finally {
      await db.close();
    }
  });
};

type StepCli = { kind: 'step'; step: string; event: StepEvent; run?: string };
type Cli = StepCli | { kind: RowKindName; pin?: string };

function parseCli(argv: string[]): Cli {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      run: { type: 'string' },
      step: { type: 'string' },
      event: { type: 'string' },
      pin: { type: 'string' },
    },
  });
  const [kind, ...extra] = positionals;
  if (kind === undefined || extra.length > 0) throw new Error('name exactly one kind');
  if (isRowKind(kind)) {
    const { pin, ...stepOnly } = values;
    if (Object.keys(stepOnly).length > 0) throw new Error('--run, --step and --event are for step');
    if (pin === undefined) return { kind };
    if (kind !== 'verdict') throw new Error('--pin is for verdict');
    if (!/^[0-9a-f]{4,40}$/.test(pin)) throw new Error(`--pin takes a sha prefix, not ${pin}`);
    return { kind, pin };
  }
  if (values.pin !== undefined) throw new Error('--pin is for verdict');
  if (kind !== 'step') throw new Error(`unknown kind ${kind}`);
  const event = EVENTS.find((name) => name === (values.event ?? 'node_completed'));
  if (!event) throw new Error(`unknown event ${values.event}`);
  return { kind, step: values.step ?? 'pick', event, run: values.run };
}

if (import.meta.main) await runCli(main);
