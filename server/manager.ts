import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type EffortLevel,
  type Options,
  query,
  type SDKMessage,
  type CanUseTool as SdkCanUseTool,
} from '@anthropic-ai/claude-agent-sdk';
import type { Server } from 'bun';
import type { Context, Hono } from 'hono';
import { parseChoices } from '../app/lib/attention';
import { lapHref, workItemHref } from '../app/lib/work-item';
import { type Db, openDb } from '../scripts/lib/db';
import type { Env } from './check-env';
import { readFactoryNames } from './factories';
import { MANAGER_LIMITS, readOnlyQuery } from './manager-sql';
import {
  AnswerSplitter,
  encodeEvent,
  MAX_PROPOSALS,
  MAX_RUNS,
  type ManagerEvent,
  parseBlock,
  type RawStructure,
  type RunSummary,
} from './manager-stream';
import { READ_TOOL_NAMES, TOOL_SERVER } from './manager-tools';

// A Record over the SDK's own type: the compiler fails on a level added or removed there.
const EFFORT_SET: Record<EffortLevel, true> = {
  low: true,
  medium: true,
  high: true,
  xhigh: true,
  max: true,
};
const EFFORTS = Object.keys(EFFORT_SET) as EffortLevel[];

export interface ManagerSettings {
  model: string;
  effort: EffortLevel;
  messageCapUsd: number;
  dayCapUsd: number;
}

function positive(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  return value;
}

function isEffort(value: string): value is EffortLevel {
  return Object.hasOwn(EFFORT_SET, value);
}

export function managerSettings(env: Env): ManagerSettings {
  const effort = env.MC_MANAGER_EFFORT || 'low';
  if (!isEffort(effort)) {
    throw new Error(`MC_MANAGER_EFFORT must be one of ${EFFORTS.join(', ')}`);
  }
  return {
    model: env.MC_MANAGER_MODEL || 'claude-sonnet-5-5',
    effort,
    messageCapUsd: positive(env, 'MC_MANAGER_MESSAGE_USD', 0.5),
    dayCapUsd: positive(env, 'MC_MANAGER_DAY_USD', 5),
  };
}

/** The SDK's `query`, narrowed to what the Manager uses, so a test can play the model. */
export type AgentRunner = (params: {
  prompt: string;
  options: Options;
}) => AsyncIterable<SDKMessage>;

interface CachedBriefing {
  day: string;
  events: ManagerEvent[];
  generatedAt: string;
}

/** The Manager's state lives in this process: a restart resets the day's spend and the briefings. */
export interface Manager {
  db: Db;
  databaseUrl: string;
  factories: string[];
  settings: ManagerSettings;
  run: AgentRunner;
  now: () => Date;
  spend: { day: string; usd: number };
  briefings: Map<string, CachedBriefing>;
  generating: Map<string, Promise<{ briefing: CachedBriefing; cost: number }>>;
  schema?: Promise<string>;
}

export function createManager(
  parts: Pick<Manager, 'db' | 'databaseUrl' | 'factories' | 'settings'> &
    Partial<Pick<Manager, 'run' | 'now'>>,
): Manager {
  const now = parts.now ?? (() => new Date());
  return {
    ...parts,
    run: parts.run ?? query,
    now,
    spend: { day: dayOf(now()), usd: 0 },
    briefings: new Map(),
    generating: new Map(),
  };
}

/** Absent without MC_DATABASE_URL: the Manager routes then answer 503. */
export function managerFromEnv(env: Env, repoRoot: string): Manager | undefined {
  const databaseUrl = env.MC_DATABASE_URL;
  if (!databaseUrl) return undefined;
  const settings = managerSettings(env);
  return createManager({
    db: openDb(databaseUrl),
    databaseUrl,
    factories: readFactoryNames(env, repoRoot),
    settings,
  });
}

/** The server's local date: the owner's machine decides when a day ends. */
function dayOf(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function spentToday(manager: Manager): number {
  const today = dayOf(manager.now());
  if (manager.spend.day !== today) manager.spend = { day: today, usd: 0 };
  return manager.spend.usd;
}

export const PLACES = ['attention', 'factory', 'board', 'runs', 'run', 'work', 'step'] as const;

export interface ChatRequest {
  factory: string;
  context: { place: (typeof PLACES)[number]; run?: string; item?: number };
  messages: { role: 'owner' | 'manager'; text: string }[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_MESSAGES = 20;
const MAX_MESSAGE_CHARS = 4000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The request, or the reason it is refused. */
export function parseChat(body: unknown, factories: string[]): ChatRequest | string {
  if (!isRecord(body)) return 'expected a JSON object';
  const { factory, context, messages } = body;
  if (typeof factory !== 'string' || !factories.includes(factory)) return 'unknown factory';
  if (!isRecord(context)) return 'context is required';
  const { place, run, item } = context;
  if (typeof place !== 'string' || !(PLACES as readonly string[]).includes(place)) {
    return 'unknown place';
  }
  if (run !== undefined && (typeof run !== 'string' || !UUID.test(run)))
    return 'run must be a UUID';
  if (item !== undefined && (typeof item !== 'number' || !Number.isInteger(item) || item < 1)) {
    return 'item must be a positive integer';
  }
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > MAX_MESSAGES) {
    return `messages must hold 1 to ${MAX_MESSAGES} entries`;
  }
  for (const message of messages) {
    if (
      !isRecord(message) ||
      (message.role !== 'owner' && message.role !== 'manager') ||
      typeof message.text !== 'string' ||
      message.text.length > MAX_MESSAGE_CHARS
    ) {
      return `each message needs a role and text of at most ${MAX_MESSAGE_CHARS} characters`;
    }
  }
  if ((messages.at(-1) as { role: string }).role !== 'owner')
    return 'the last message is the owner’s';
  return {
    factory,
    context: { place: place as ChatRequest['context']['place'], run, item },
    messages: messages as ChatRequest['messages'],
  };
}

const PASSED_TO_CLI = [
  'PATH',
  'HOME',
  'USERPROFILE',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'APPDATA',
  'LOCALAPPDATA',
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
];

function pick(env: NodeJS.ProcessEnv, names: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of names) {
    const value = env[name];
    if (value !== undefined) out[name] = value;
  }
  return out;
}

/** The machine's own Claude login is not in the environment, so this can only say "none set". */
function hasCredential(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.CLAUDE_CODE_OAUTH_TOKEN || env.ANTHROPIC_API_KEY);
}

const canUseTool: SdkCanUseTool = async (name, input) =>
  READ_TOOL_NAMES.includes(name)
    ? { behavior: 'allow', updatedInput: input }
    : { behavior: 'deny', message: `${name} is not a Manager tool` };

/**
 * The agent run's options. No built-in tool exists at all (`tools: []`); the two MCP tools are the
 * only ones, and the CLI's environment is an allowlist with no database URL: the URL reaches the
 * tool subprocess alone (invariant 7).
 */
export function buildOptions(
  manager: Manager,
  request: ChatRequest,
  extra: {
    cwd: string;
    systemPrompt: string;
    maxBudgetUsd: number;
    abortController: AbortController;
  },
  env: NodeJS.ProcessEnv = process.env,
): Options {
  return {
    cwd: extra.cwd,
    tools: [],
    allowedTools: READ_TOOL_NAMES,
    permissionMode: 'dontAsk',
    canUseTool,
    mcpServers: {
      [TOOL_SERVER]: {
        type: 'stdio',
        command: process.execPath,
        args: [join(import.meta.dir, 'manager-tools.ts')],
        env: {
          ...pick(env, ['PATH', 'SYSTEMROOT', 'TEMP', 'TMP']),
          MC_DATABASE_URL: manager.databaseUrl,
          MC_MANAGER_FACTORY: request.factory,
        },
      },
    },
    strictMcpConfig: true,
    settingSources: [],
    persistSession: false,
    includePartialMessages: true,
    systemPrompt: extra.systemPrompt,
    model: manager.settings.model,
    effort: manager.settings.effort,
    maxTurns: 12,
    maxBudgetUsd: extra.maxBudgetUsd,
    abortController: extra.abortController,
    env: pick(env, PASSED_TO_CLI),
  };
}

/** The `mc` schema's columns, read once per process with trusted SQL. */
function describeSchema(manager: Manager): Promise<string> {
  manager.schema ??= readOnlyQuery(
    manager.db,
    `SELECT table_name, string_agg(column_name || ' ' || data_type, ', ' ORDER BY ordinal_position) AS columns
       FROM information_schema.columns WHERE table_schema = 'mc' GROUP BY table_name ORDER BY table_name`,
    [],
    MANAGER_LIMITS,
  ).then(
    ({ rows }) => rows.map((row) => `mc.${row.table_name}(${row.columns})`).join('\n'),
    (error) => {
      manager.schema = undefined;
      console.error(
        `describing the mc schema failed: ${error instanceof Error ? error.message : error}`,
      );
      return '';
    },
  );
  return manager.schema;
}

function systemPrompt(manager: Manager, request: ChatRequest, schema: string): string {
  const now = manager.now();
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const { place, run, item } = request.context;
  const viewing = [run && `run ${run}`, item && `work item #${item}`].filter(Boolean).join(', ');
  return `You are the Manager of the factory "${request.factory}". You watch every run and queue for its owner and answer what they ask, from the factory's data only.
Today is ${dayOf(now)} (${zone}); a day runs midnight to midnight in that timezone. The owner is on the ${place} page${viewing ? `, looking at ${viewing}` : ''}.

Tools: live_query runs one of the dashboard's named queries for this factory; select runs one SELECT over the mc schema (at most ${MANAGER_LIMITS.rowCap} rows, ${MANAGER_LIMITS.timeoutMs / 1000}s). Both only read. You cannot change anything, and you must never say that you did.
Never show holdout scenario text.
A run failed on the day its mc.laps.completed_at falls, whatever day it started: for "failed today", filter on completed_at, never started_at, and include runs that started on an earlier day. The database session may run in another timezone, so convert first: (completed_at AT TIME ZONE '${zone}')::date = DATE '${dayOf(now)}'.

The mc schema:
${schema}

Answer in short plain prose, naming runs by workflow and status. To give the owner links, a run list or a button, end the answer with one fenced block whose info string is mc, holding JSON:
\`\`\`mc
{"links":[{"kind":"run","id":"<run id>"},{"kind":"item","id":<issue number>}],"runs":["<run id>"],"proposals":[{"action":"answer","run_id":"<run id>","option":"<option id>"},{"action":"answer","run_id":"<run id>","text":"<free text>"},{"action":"resume","run_id":"<run id>","from_step":"<step id>"}]}
\`\`\`
Every field is optional. Propose an answer only for a run waiting on a question in mc.attention_items, using one of its option ids (or text for "Something else"). Propose a resume only for a failed or paused run; from_step is optional. A proposal is a button the owner presses; it does nothing until they do. At most ${MAX_RUNS} runs and ${MAX_PROPOSALS} proposals.`;
}

function renderConversation(messages: ChatRequest['messages']): string {
  return messages.map((m) => `${m.role === 'owner' ? 'Owner' : 'Manager'}: ${m.text}`).join('\n\n');
}

/** Settling by differences leaves float dust that would show in the owner's spend. */
const microdollars = (amount: number) => Math.round(amount * 1e6) / 1e6;

const usd = (amount: number) => `$${amount.toFixed(2)}`;

const NOTICES = {
  'day-cap': (m: Manager) =>
    `Today's Manager budget of ${usd(m.settings.dayCapUsd)} is spent. It resets at midnight.`,
  'message-cap': (m: Manager) =>
    `This answer stopped at the ${usd(m.settings.messageCapUsd)} limit for one message. Ask a narrower question.`,
  unavailable: () =>
    'The Manager could not answer right now. The server log has the details.' +
    (hasCredential(process.env)
      ? ''
      : ' Neither CLAUDE_CODE_OAUTH_TOKEN nor ANTHROPIC_API_KEY is set on the server: set CLAUDE_CODE_OAUTH_TOKEN, or log in to Claude on the machine that runs it.'),
};

function notice(manager: Manager, kind: keyof typeof NOTICES): ManagerEvent {
  return { type: 'notice', kind, text: NOTICES[kind](manager) };
}

type Emit = (event: ManagerEvent) => void;

async function lookup(manager: Manager, sql: string, params: unknown[]) {
  return (await readOnlyQuery(manager.db, sql, params, MANAGER_LIMITS)).rows;
}

async function runSummaries(
  manager: Manager,
  factory: string,
  ids: string[],
): Promise<RunSummary[]> {
  const valid = [...new Set(ids.filter((id) => UUID.test(id)).map((id) => id.toLowerCase()))];
  if (valid.length === 0) return [];
  const rows = await lookup(
    manager,
    `SELECT run_id::text AS run_id, workflow_name, status, started_at::text AS started_at, completed_at::text AS completed_at
       FROM mc.laps WHERE factory = $1 AND run_id::text IN (SELECT jsonb_array_elements_text($2::jsonb))`,
    [factory, valid],
  );
  const byId = new Map(rows.map((row) => [String(row.run_id), row]));
  return valid.flatMap((id) => {
    const row = byId.get(id);
    if (!row) return [];
    return [
      {
        run_id: id,
        workflow_name: String(row.workflow_name),
        status: String(row.status),
        started_at: row.started_at === null ? null : String(row.started_at),
        completed_at: row.completed_at === null ? null : String(row.completed_at),
        href: lapHref(factory, id),
      },
    ];
  });
}

async function linkEvents(manager: Manager, factory: string, links: RawStructure['links']) {
  const events: ManagerEvent[] = [];
  const runs = await runSummaries(
    manager,
    factory,
    links.filter((l) => l.kind === 'run').map((l) => String(l.id)),
  );
  for (const run of runs) {
    events.push({
      type: 'link',
      kind: 'run',
      id: run.run_id,
      label: `${run.workflow_name} ${run.run_id.slice(0, 8)}`,
      href: run.href,
    });
  }
  for (const link of links.filter((l) => l.kind === 'item')) {
    const number = Number(link.id);
    if (!Number.isInteger(number) || number < 1) continue;
    const [row] = await lookup(
      manager,
      'SELECT title FROM mc.issues WHERE factory = $1 AND number = $2::int',
      [factory, number],
    );
    if (row) {
      events.push({
        type: 'link',
        kind: 'item',
        id: number,
        label: `#${number} ${row.title}`,
        href: workItemHref(factory, number),
      });
    }
  }
  return events;
}

/**
 * A proposal the database backs: the run waits on a question and the option is one of its own, or
 * the run failed or paused and the step is one it ran. The server writes `occurrence` and `label`.
 */
async function proposalEvent(
  manager: Manager,
  factory: string,
  raw: RawStructure['proposals'][number],
): Promise<ManagerEvent | undefined> {
  if (!UUID.test(raw.run_id)) return undefined;
  const runId = raw.run_id.toLowerCase();
  if (raw.action === 'answer') {
    const [row] = await lookup(
      manager,
      `SELECT node_id, options::text AS options
         FROM mc.attention_items WHERE factory = $1 AND run_id::text = $2`,
      [factory, runId],
    );
    if (!row) return undefined;
    const base = { type: 'proposal', action: 'answer', factory, run_id: runId } as const;
    const occurrence = String(row.node_id);
    if (raw.option !== undefined) {
      const choice = parseChoices(String(row.options)).find((o) => o.id === raw.option);
      if (!choice) return undefined;
      return {
        ...base,
        occurrence,
        option: choice.id,
        text: null,
        label: `Answer "${choice.label ?? choice.id}"`,
      };
    }
    if (raw.text === undefined || raw.text.length < 1 || raw.text.length > 2000) return undefined;
    return { ...base, occurrence, option: null, text: raw.text, label: 'Answer with your text' };
  }
  const [lap] = await lookup(
    manager,
    "SELECT 1 AS found FROM mc.laps WHERE factory = $1 AND run_id::text = $2 AND status IN ('failed', 'paused')",
    [factory, runId],
  );
  if (!lap) return undefined;
  if (raw.from_step !== undefined) {
    const [step] = await lookup(
      manager,
      'SELECT 1 AS found FROM mc.lap_steps WHERE run_id::text = $1 AND step_id = $2',
      [runId, raw.from_step],
    );
    if (!step) return undefined;
  }
  return {
    type: 'proposal',
    action: 'resume',
    factory,
    run_id: runId,
    from_step: raw.from_step ?? null,
    label: raw.from_step ? `Resume from ${raw.from_step}` : 'Resume',
  };
}

/** Every entry the model named, checked against `mc`; what fails is dropped and logged. */
async function structureEvents(manager: Manager, factory: string, block: string | null) {
  const raw = parseBlock(block);
  const events: ManagerEvent[] = await linkEvents(manager, factory, raw.links);
  const runs = await runSummaries(manager, factory, raw.runs.slice(0, MAX_RUNS));
  if (runs.length > 0) events.push({ type: 'runs', runs });
  let proposals = 0;
  for (const proposal of raw.proposals) {
    if (proposals === MAX_PROPOSALS) break;
    const event = await proposalEvent(manager, factory, proposal);
    if (event) {
      events.push(event);
      proposals++;
    } else {
      console.warn(`manager: dropped a ${proposal.action} proposal the database does not back`);
    }
  }
  return events;
}

interface Outcome {
  ok: boolean;
  cost: number;
}

/** Runs the agent for one request and emits every event but `done`. */
async function produce(
  manager: Manager,
  request: ChatRequest,
  signal: AbortSignal,
  emit: Emit,
): Promise<Outcome> {
  const left = manager.settings.dayCapUsd - spentToday(manager);
  if (left <= 0) {
    emit(notice(manager, 'day-cap'));
    return { ok: false, cost: 0 };
  }
  const maxBudgetUsd = Math.min(manager.settings.messageCapUsd, left);
  // The ceiling is spent from the day's tally before the run, so requests in flight together
  // cannot each count on the same money; it is settled to the real cost only when one arrives.
  const tally = manager.spend;
  tally.usd = microdollars(tally.usd + maxBudgetUsd);
  const abortController = new AbortController();
  const abort = () => abortController.abort();
  signal.addEventListener('abort', abort);
  let cwd: string | undefined;
  const splitter = new AnswerSplitter();
  let wrote = false;
  let started = false;
  const show = (text: string) => {
    if (text) {
      wrote = true;
      emit({ type: 'text', text });
    }
  };
  let cost = maxBudgetUsd;
  let failed = false;
  let resulted = false;
  let stop: 'success' | 'budget' | 'error' = 'error';
  try {
    cwd = mkdtempSync(join(tmpdir(), 'mc-manager-'));
    const prompt = renderConversation(request.messages);
    const system = systemPrompt(manager, request, await describeSchema(manager));
    const messages = manager.run({
      prompt,
      options: buildOptions(manager, request, {
        cwd,
        systemPrompt: system,
        maxBudgetUsd,
        abortController,
      }),
    });
    for await (const message of messages) {
      if (message.type === 'stream_event') {
        const { event } = message;
        if (event.type === 'message_start') {
          if (started && wrote) show(splitter.push('\n\n'));
          started = true;
        } else if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          show(splitter.push(event.delta.text));
        }
      } else if (message.type === 'result') {
        resulted = true;
        tally.usd = microdollars(tally.usd + message.total_cost_usd - cost);
        cost = message.total_cost_usd;
        if (message.subtype === 'success' && !message.is_error) stop = 'success';
        else if (message.subtype === 'error_max_budget_usd') stop = 'budget';
        else {
          const reason = 'result' in message ? message.result : message.errors.join('; ');
          console.error(`manager run ended with ${message.subtype}: ${reason}`);
        }
      }
    }
  } catch (error) {
    // Upstream text can carry a connection string: it stays in the log.
    failed = true;
    console.error(`manager failed: ${error instanceof Error ? error.message : error}`);
  } finally {
    signal.removeEventListener('abort', abort);
    if (cwd) rmSync(cwd, { recursive: true, force: true });
  }
  if (stop === 'error' && !failed && !resulted) console.error('manager run ended without a result');
  const { text, block } = splitter.end();
  show(text);
  if (stop === 'error') {
    // A run that never reached the model spent nothing: it must not fill the day cap.
    if (!resulted && !started) {
      tally.usd = microdollars(tally.usd - maxBudgetUsd);
      cost = 0;
    }
    emit(notice(manager, 'unavailable'));
    return { ok: false, cost };
  }
  let structured = true;
  try {
    for (const event of await structureEvents(manager, request.factory, block)) emit(event);
  } catch (error) {
    structured = false;
    console.error(`manager structure failed: ${error instanceof Error ? error.message : error}`);
  }
  if (stop === 'budget') {
    emit(
      notice(manager, maxBudgetUsd < manager.settings.messageCapUsd ? 'day-cap' : 'message-cap'),
    );
  }
  if (!structured) emit(notice(manager, 'unavailable'));
  return { ok: stop === 'success' && structured, cost };
}

function done(manager: Manager, cost: number, extra: Partial<ManagerEvent> = {}): ManagerEvent {
  return {
    type: 'done',
    cost_usd: cost,
    day_spent_usd: spentToday(manager),
    day_cap_usd: manager.settings.dayCapUsd,
    ...extra,
  } as ManagerEvent;
}

function ndjson(fill: (emit: Emit) => Promise<void>): Response {
  const encoder = new TextEncoder();
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit: Emit = (event) => {
        if (!closed) controller.enqueue(encoder.encode(encodeEvent(event)));
      };
      try {
        await fill(emit);
      } finally {
        if (!closed) controller.close();
      }
    },
    cancel() {
      closed = true;
    },
  });
  return new Response(stream, {
    headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export function answer(manager: Manager, request: ChatRequest, signal: AbortSignal): Response {
  return ndjson(async (emit) => {
    const { cost } = await produce(manager, request, signal, emit);
    emit(done(manager, cost));
  });
}

const BRIEFING_QUESTION =
  "Write today's briefing: what merged, what failed (count a run by the day it failed, completed_at, not the day it started), what waits on the owner, and the one or two things that matter most.";

async function generateBriefing(manager: Manager, factory: string) {
  const events: ManagerEvent[] = [];
  const request: ChatRequest = {
    factory,
    context: { place: 'attention' },
    messages: [{ role: 'owner', text: BRIEFING_QUESTION }],
  };
  const { ok, cost } = await produce(manager, request, new AbortController().signal, (event) =>
    events.push(event),
  );
  const briefing = { day: dayOf(manager.now()), events, generatedAt: manager.now().toISOString() };
  if (ok) manager.briefings.set(factory, briefing);
  return { briefing, cost };
}

/** A briefing is shared by whoever asks, so one asker leaving does not stop its generation. */
export function briefing(manager: Manager, factory: string, refresh: boolean): Response {
  return ndjson(async (emit) => {
    const cached = manager.briefings.get(factory);
    if (!refresh && cached && cached.day === dayOf(manager.now())) {
      for (const event of cached.events) emit(event);
      emit(done(manager, 0, { generated_at: cached.generatedAt, cached: true }));
      return;
    }
    let pending = manager.generating.get(factory);
    if (!pending) {
      pending = generateBriefing(manager, factory);
      manager.generating.set(factory, pending);
      pending.then(
        () => manager.generating.delete(factory),
        () => manager.generating.delete(factory),
      );
    }
    const { briefing: made, cost } = await pending;
    for (const event of made.events) emit(event);
    emit(done(manager, cost, { generated_at: made.generatedAt, cached: false }));
  });
}

/**
 * Bun closes a request after 10 idle seconds, and an answer or briefing is silent while the model
 * works. Under `Bun.serve` the server is Hono's `c.env`; `app.request` has none.
 */
function keepOpen(c: Context): void {
  (c.env as Server<unknown> | undefined)?.timeout(c.req.raw, 0);
}

const NOT_CONFIGURED = { error: 'the manager is not configured' };

export function managerRoutes(app: Hono, manager: Manager | undefined): void {
  app.post('/api/manager/chat', async (c) => {
    if (!manager) return c.json(NOT_CONFIGURED, 503);
    const request = parseChat(await c.req.json().catch(() => undefined), manager.factories);
    if (typeof request === 'string') return c.json({ error: request }, 400);
    keepOpen(c);
    return answer(manager, request, c.req.raw.signal);
  });

  app.post('/api/manager/briefing', async (c) => {
    if (!manager) return c.json(NOT_CONFIGURED, 503);
    const body = await c.req.json().catch(() => undefined);
    const factory = isRecord(body) ? body.factory : undefined;
    if (typeof factory !== 'string' || !manager.factories.includes(factory)) {
      return c.json({ error: 'unknown factory' }, 400);
    }
    const refresh = isRecord(body) && body.refresh === true;
    keepOpen(c);
    return briefing(manager, factory, refresh);
  });
}
