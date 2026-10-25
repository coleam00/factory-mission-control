import { parseArgs } from 'node:util';
import { failing, guardedDatabaseUrl, type Main, runCli } from '../lib/cli';
import type { Row, Tx } from '../lib/db';

const EVENTS = ['node_started', 'node_completed', 'node_failed'] as const;
type StepEvent = (typeof EVENTS)[number];

const USAGE =
  'usage: bun run fixture:write step [--run <id>] [--step <step id>] [--event node_started|node_completed|node_failed]';

const WORKFLOW = 'archon-loop';
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

/** The keys Archon's executor writes into `data` for a node event, with fixture values. */
export function eventData(step: string, event: StepEvent, now: Date): Record<string, unknown> {
  const isScript = step === 'land';
  const startedAt = new Date(now.getTime() - 184_250).toISOString();
  const node = {
    node: { id: step, kind: isScript ? 'script' : 'command', source: { kind: 'project' } },
    type: isScript ? 'script' : 'command',
    command: isScript ? null : (COMMANDS[step] ?? step),
    accounting: 'node',
    ...(isScript ? {} : { tier: 'medium', model: 'sonnet', provider: 'claude' }),
  };
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
    [
      WORKFLOW,
      'Run the loop on coleam00/factory-mission-control',
      { workflow_source: { digest: FIXTURE_DIGEST } },
    ],
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

export const main: Main = async (argv, deps) => {
  let parsed: ReturnType<typeof parseCli>;
  try {
    parsed = parseCli(argv);
  } catch (error) {
    deps.err(error instanceof Error ? `${error.message}\n${USAGE}` : USAGE);
    return 2;
  }
  const { step, event, run } = parsed;
  return failing(deps, async () => {
    const db = deps.openDb(await guardedDatabaseUrl(deps, 'check'));
    try {
      let report = '';
      await db.transaction(async (tx) => {
        const runId = run ?? (await runningRunId(tx));
        const before = await eventCount(tx, runId);
        const [inserted] = await tx.query(
          'INSERT INTO remote_agent_workflow_events (workflow_run_id, event_type, step_name, data) VALUES ($1, $2, $3, $4::jsonb) RETURNING jsonb_typeof(data) AS stored',
          [runId, event, step, eventData(step, event, deps.now())],
        );
        requireObject('the event data', inserted);
        report = `events for run ${runId}: ${before} -> ${await eventCount(tx, runId)}`;
      });
      deps.out(report);
    } finally {
      await db.close();
    }
  });
};

function parseCli(argv: string[]): { step: string; event: StepEvent; run?: string } {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      run: { type: 'string' },
      step: { type: 'string', default: 'pick' },
      event: { type: 'string', default: 'node_completed' },
    },
  });
  if (positionals.length !== 1 || positionals[0] !== 'step') {
    throw new Error('the only kind is `step`');
  }
  const event = EVENTS.find((name) => name === values.event);
  if (!event) throw new Error(`unknown event ${values.event}`);
  return { step: values.step, event, run: values.run };
}

if (import.meta.main) await runCli(main);
