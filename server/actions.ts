/**
 * The only code that writes to a factory (PRD invariant 2): answer a paused run's question, resume
 * a run, re-triage, close or comment on a work item, each through that factory's own Archon CLI and
 * each recorded in `mc.actions`.
 *
 * One press is one record and runs the calls below in order, stopping at the first that fails. Every
 * part of an argv is a literal, a database value, the operator's `login`, or the owner's one free
 * text, which travels inside a single `--text=` or JSON `--data=` element:
 *   answer    workflow answer <run> --occurrence=<id> [--choose=<option id>] [--text=<text>] --json
 *   resume    workflow resume <run> --detach --json
 *   retriage  forge workitem.label.add --data=<json>, then
 *             workflow run archon-intake --input=name=value ... --detach
 *   close     forge workitem.comment.upsert --data=<json>, then forge workitem.close --data=<json>
 *   comment   forge workitem.comment.upsert --data=<json>, then the two calls of retriage
 * `--name=value` keeps the owner's text one argv element the CLI cannot read as another flag. The
 * command, its cwd and env come only from the operator file, never from a request.
 *
 * `from_step` is recorded, not sent: `archon workflow resume` has no step argument and re-runs the
 * step that failed, so the server accepts only that step.
 */
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { Hono } from 'hono';
import type {
  ActionBody,
  ActionRequest,
  ActionResult,
  Operators as OperatorsBody,
} from '../app/lib/actions';
import { needsLogin } from '../app/lib/actions';
import {
  ANSWER_TEXT_MAX,
  type AttentionOption,
  isAnswerText,
  parseChoices,
  resolveAnswer,
} from '../app/lib/attention';
import { INTAKE_WORKFLOW, isRunId } from '../app/lib/one-lap';
import { type Db, openDb } from '../scripts/lib/db';
import type { Env } from './check-env';
import { BASE_ENV_NAMES, pick } from './child-env';
import { isObject, readFactoryNames } from './factories';
import { RESUMABLE_STATUSES } from './manager-stream';

export interface Operator {
  who: string;
  /** The owner's forge login, which intake checks against the maintainers; `who` is not it. */
  login: string | null;
  command: string[];
  cwd: string;
  env: Record<string, string>;
}
export type Operators = Map<string, Operator>;

export interface Actions {
  db: Db;
  operators: Operators;
}

const SPAWN_TIMEOUT_MS = 60_000;
const SUMMARY_CHARS = 2000;

function operatorEntry(name: string, raw: unknown): Operator {
  const where = `operators.${name}`;
  if (!isObject(raw)) throw new Error(`${where} must be an object`);
  const { who, login, command, cwd, env } = raw;
  if (typeof who !== 'string' || who === '') throw new Error(`${where}.who must be a string`);
  if (login !== undefined && !(typeof login === 'string' && /^\S+$/.test(login))) {
    throw new Error(`${where}.login must be a forge login with no spaces`);
  }
  if (
    !Array.isArray(command) ||
    command.length === 0 ||
    !command.every((part) => typeof part === 'string' && part !== '')
  ) {
    throw new Error(`${where}.command must be a non-empty array of non-empty strings`);
  }
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) {
    throw new Error(`${where}.cwd must be an absolute path`);
  }
  if (
    env !== undefined &&
    !(isObject(env) && Object.values(env).every((value) => typeof value === 'string'))
  ) {
    throw new Error(`${where}.env must map names to strings`);
  }
  return {
    who,
    login: login ?? null,
    command,
    cwd,
    env: (env as Record<string, string> | undefined) ?? {},
  };
}

/** The owner's operator file; a missing file is no entries, a malformed one an error. */
export function loadOperators(env: Env, repoRoot: string, factories: string[]): Operators {
  const file = env.MC_OPERATORS_FILE || join(repoRoot, '.mc-local', 'operators.json');
  if (!existsSync(file)) return new Map();
  const config: unknown = JSON.parse(readFileSync(file, 'utf-8'));
  if (!isObject(config) || !isObject(config.operators)) {
    throw new Error(`${file}: expected an object with an operators object`);
  }
  const operators: Operators = new Map();
  for (const [name, raw] of Object.entries(config.operators)) {
    if (!factories.includes(name)) throw new Error(`${file}: operators.${name} is not a factory`);
    operators.set(name, operatorEntry(name, raw));
  }
  return operators;
}

const ACTIONS = ['answer', 'resume', 'retriage', 'close', 'comment'] as const;
type Of<A extends ActionBody['action']> = Extract<ActionBody, { action: A }>;
const KEYS: Record<(typeof ACTIONS)[number], string[]> = {
  answer: Object.keys({
    factory: true,
    action: true,
    run_id: true,
    occurrence: true,
    option: true,
    text: true,
    undone: true,
  } satisfies Record<keyof Of<'answer'>, true>),
  resume: Object.keys({
    factory: true,
    action: true,
    run_id: true,
    from_step: true,
    undone: true,
  } satisfies Record<keyof Of<'resume'>, true>),
  retriage: Object.keys({
    factory: true,
    action: true,
    number: true,
    undone: true,
  } satisfies Record<keyof Of<'retriage'>, true>),
  close: Object.keys({
    factory: true,
    action: true,
    number: true,
    undone: true,
  } satisfies Record<keyof Of<'close'>, true>),
  comment: Object.keys({
    factory: true,
    action: true,
    number: true,
    text: true,
    undone: true,
  } satisfies Record<keyof Of<'comment'>, true>),
};

const boundedString = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length >= 1 && value.length <= max;
const nullOrBounded = (value: unknown, max: number): value is string | null =>
  value === null || boundedString(value, max);
const isItemNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 999_999_999;

/** The strict allowlist: exactly the keys of one of the five actions, nothing else; a string is the refusal reason. */
export function parseActionBody(body: unknown): ActionBody | string {
  if (!isObject(body)) return 'the body must be a JSON object';
  const action = ACTIONS.find((name) => name === body.action);
  if (!action) return 'action must be answer, resume, retriage, close or comment';
  const keys = KEYS[action];
  const extra = Object.keys(body).filter((key) => !keys.includes(key));
  const missing = keys.filter((key) => !(key in body));
  if (extra.length > 0) return `not accepted: ${extra.join(', ')}`;
  if (missing.length > 0) return `missing: ${missing.join(', ')}`;
  if (!boundedString(body.factory, 200)) return 'factory must be a string';
  if (typeof body.undone !== 'boolean') return 'undone must be a boolean';
  const common = { factory: body.factory, undone: body.undone };
  if (action === 'retriage' || action === 'close' || action === 'comment') {
    if (!isItemNumber(body.number)) return 'number must be an issue number';
    if (action !== 'comment') return { ...common, action, number: body.number };
    if (!isAnswerText(body.text)) return `text must be 1-${ANSWER_TEXT_MAX} characters`;
    return { ...common, action, number: body.number, text: body.text };
  }
  if (typeof body.run_id !== 'string' || !isRunId(body.run_id)) return 'run_id must be a run id';
  const run = { ...common, run_id: body.run_id.toLowerCase() };
  if (action === 'resume') {
    if (!nullOrBounded(body.from_step, 200)) return 'from_step must be a step id or null';
    return { ...run, action, from_step: body.from_step };
  }
  if (!boundedString(body.occurrence, 200)) return 'occurrence must be a string';
  if (!nullOrBounded(body.option, 200)) return 'option must be an option id or null';
  if (body.text !== null && !isAnswerText(body.text))
    return `text must be 1-${ANSWER_TEXT_MAX} characters or null`;
  if ((body.option === null) === (body.text === null)) return 'send exactly one of option and text';
  return { ...run, action, occurrence: body.occurrence, option: body.option, text: body.text };
}

/** A row when the run is in a status Archon can resume. */
export const RESUMABLE_RUN_SQL = `SELECT 1 AS found FROM mc.laps
  WHERE factory = $1 AND run_id::text = $2
    AND status IN (${RESUMABLE_STATUSES.map((status) => `'${status}'`).join(', ')})`;

/** A row when the run failed and `$3` is the step Archon re-runs: its stop step or a failed step. */
export const RESUME_FROM_SQL = `SELECT 1 AS found FROM mc.laps l
  WHERE l.factory = $1 AND l.run_id::text = $2 AND l.status = 'failed'
    AND ($3 IN (SELECT s.step_id FROM mc.run_stops s WHERE s.run_id = l.run_id)
      OR $3 IN (SELECT s.step_id FROM mc.lap_steps s WHERE s.run_id = l.run_id AND s.status = 'failed'))`;

/** The open question of a run: its form, choices and occurrence. */
export const OPEN_QUESTION_SQL = `SELECT form, options::text AS options, occurrence_id
  FROM mc.attention_items WHERE factory = $1 AND run_id::text = $2`;

/** The repository of an open issue of the factory; no row when it is closed or not mirrored. */
export const OPEN_ISSUE_SQL = `SELECT f.repository FROM mc.issues i
  JOIN mc.factories f ON f.name = i.factory
  WHERE i.factory = $1 AND i.number = $2 AND i.state = 'open'`;

/** An `OPEN_QUESTION_SQL` row as the answer rule takes it; `occurrence` is null when the row has none. */
export function openQuestionOf(row: Record<string, unknown>): {
  form: string;
  options: AttentionOption[];
  occurrence: string | null;
} {
  return {
    form: String(row.form),
    options: parseChoices(String(row.options)),
    occurrence: row.occurrence_id === null ? null : String(row.occurrence_id),
  };
}

/** The forge every factory's repository lives on. */
export const FORGE_HOST = 'github.com';
const TRIAGE_LABEL = 'archon-triage';
const CLOSED_MARKER = '<!-- mission-control:closed -->';

/** One CLI invocation of an action; `call` names it in the recorded output. */
export interface Call {
  call: string;
  argv: string[];
}

const forgeCall = (call: string, operation: string, data: object): Call => ({
  call,
  argv: ['forge', operation, `--data=${JSON.stringify(data)}`],
});
const issueRef = (repository: string, number: number) => ({
  repo: { host: FORGE_HOST, path: repository },
  number,
});
const commentCall = (
  call: string,
  repository: string,
  number: number,
  marker: string,
  text: string,
) =>
  forgeCall(call, 'workitem.comment.upsert', {
    subject: { kind: 'issue', ref: issueRef(repository, number) },
    marker,
    body: `${marker}\n\n${text}`,
  });

/** Label the issue, then start intake as the maintainer `login`, whose label request intake honours. */
export function retriageCalls(repository: string, number: number, login: string): Call[] {
  return [
    forgeCall('label', 'workitem.label.add', {
      subject: { kind: 'issue', ref: issueRef(repository, number) },
      name: TRIAGE_LABEL,
    }),
    {
      call: 'intake',
      argv: [
        'workflow',
        'run',
        INTAKE_WORKFLOW,
        `--input=repo_host=${FORGE_HOST}`,
        `--input=repo_path=${repository}`,
        `--input=number=${number}`,
        '--input=action=added',
        `--input=label=${TRIAGE_LABEL}`,
        `--input=label_actor=${login}`,
        '--detach',
      ],
    },
  ];
}

/** The note first, so the issue is never closed without it; its marker is fixed, so a retry rewrites it. */
export function closeCalls(repository: string, number: number): Call[] {
  return [
    commentCall(
      'close-comment',
      repository,
      number,
      CLOSED_MARKER,
      'Closed by the owner from Mission Control.',
    ),
    forgeCall('close', 'workitem.close', {
      ref: issueRef(repository, number),
      reason: 'not_planned',
    }),
  ];
}

/** `markerId` makes the marker unique to this press, so it adds a comment and overwrites no earlier one. */
export function commentCalls(
  repository: string,
  number: number,
  login: string,
  text: string,
  markerId: string,
): Call[] {
  const marker = `<!-- mission-control:comment:${markerId} -->`;
  return [
    commentCall('comment', repository, number, marker, text),
    ...retriageCalls(repository, number, login),
  ];
}

type Checked = { calls: Call[]; option: string | null } | { status: 403 | 409; error: string };

type ItemRequest = Extract<ActionRequest, { action: 'retriage' | 'close' | 'comment' }>;

async function checkItem(db: Db, request: ItemRequest, login: string | null): Promise<Checked> {
  const notOpen = {
    status: 409,
    error: `#${request.number} is not an open issue of this factory`,
  } as const;
  const repositoryOf = async () => {
    const [row] = await db.query(OPEN_ISSUE_SQL, [request.factory, request.number]);
    return row === undefined ? null : String(row.repository);
  };
  if (!needsLogin(request.action)) {
    const repository = await repositoryOf();
    return repository === null
      ? notOpen
      : { calls: closeCalls(repository, request.number), option: null };
  }
  if (login === null) {
    return {
      status: 403,
      error: `the operator entry for ${request.factory} has no login; intake re-triages only for a listed maintainer`,
    };
  }
  const repository = await repositoryOf();
  if (repository === null) return notOpen;
  const calls =
    request.action === 'comment'
      ? commentCalls(repository, request.number, login, request.text, crypto.randomUUID())
      : retriageCalls(repository, request.number, login);
  return { calls, option: null };
}

/** Checks a request against the database; the calls are built from its rows, not from the request. */
export async function checkAgainstDb(
  db: Db,
  request: ActionRequest,
  login: string | null,
): Promise<Checked> {
  if (request.action === 'retriage' || request.action === 'close' || request.action === 'comment') {
    return checkItem(db, request, login);
  }
  if (request.action === 'resume') {
    const [lap] = await db.query(RESUMABLE_RUN_SQL, [request.factory, request.run_id]);
    if (!lap) return { status: 409, error: 'the run is not failed or paused' };
    if (request.from_step !== null) {
      const [step] = await db.query(RESUME_FROM_SQL, [
        request.factory,
        request.run_id,
        request.from_step,
      ]);
      if (!step) return { status: 409, error: 'that is not the step that failed' };
    }
    return {
      calls: [
        { call: 'resume', argv: ['workflow', 'resume', request.run_id, '--detach', '--json'] },
      ],
      option: null,
    };
  }
  const [row] = await db.query(OPEN_QUESTION_SQL, [request.factory, request.run_id]);
  const question = row === undefined ? undefined : openQuestionOf(row);
  if (question === undefined || question.occurrence !== request.occurrence) {
    return { status: 409, error: 'the question is no longer open' };
  }
  const resolved = resolveAnswer(question, request);
  if ('error' in resolved) return { status: 409, error: resolved.error };
  const option = resolved.option;
  const text = request.text === null ? [] : [`--text=${request.text}`];
  return {
    calls: [
      {
        call: 'answer',
        argv: [
          'workflow',
          'answer',
          request.run_id,
          `--occurrence=${question.occurrence}`,
          ...(option === null ? [] : [`--choose=${option}`]),
          ...text,
          '--json',
        ],
      },
    ],
    option,
  };
}

/**
 * The CLI's own error when it printed one, else its output; at most 2000 characters. The reply is
 * the whole output or its last line: `workflow` prints one line, `forge` pretty-prints several.
 */
export function summarize(stdout: string, stderr: string): string {
  const whole = stdout.trim();
  let text = whole || stderr.trim();
  for (const candidate of [whole, whole.split('\n').pop() ?? '']) {
    try {
      const reply: unknown = JSON.parse(candidate);
      if (!isObject(reply)) continue;
      const { error } = reply;
      if (typeof error === 'string') text = error;
      else if (isObject(error) && typeof error.message === 'string') text = error.message;
      else if (reply.ok === true) text = JSON.stringify(reply);
      break;
    } catch {
      // Not JSON: try the last line, then the output itself.
    }
  }
  return text.slice(0, SUMMARY_CHARS);
}

export type Outcome = { status: 200; result: ActionResult } | { status: number; error: string };

async function spawnCli(operator: Operator, argv: string[]) {
  try {
    const child = Bun.spawn([...operator.command, ...argv], {
      cwd: operator.cwd,
      env: { ...pick(process.env, BASE_ENV_NAMES), ...operator.env },
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: SPAWN_TIMEOUT_MS,
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (child.signalCode) {
      return {
        exitCode: null,
        output: `stopped by ${child.signalCode} (limit ${SPAWN_TIMEOUT_MS / 1000} s)`,
      };
    }
    return { exitCode: code, output: summarize(stdout, stderr) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { exitCode: null, output: message.slice(0, SUMMARY_CHARS) };
  }
}

/** What a call that exited 0 did, for the first line of a result that failed after it. */
const WENT_THROUGH: Readonly<Record<string, string>> = {
  label: 'label added',
  'close-comment': 'close note posted',
  comment: 'comment posted',
};

/**
 * Runs the calls in order and stops at the first that does not exit 0. The exit code is the last
 * call's, so 0 means every call passed. With several calls the output has one `<call>: <summary>`
 * line per call that ran, the failing one first. When a call failed after others went through, that
 * first line names them: "comment posted, then label failed: ...".
 */
async function runCalls(operator: Operator, calls: Call[]) {
  const ran: { call: string; exitCode: number | null; output: string }[] = [];
  for (const { call, argv } of calls) {
    const result = await spawnCli(operator, argv);
    ran.push({ call, ...result });
    if (result.exitCode !== 0) break;
  }
  const last = ran[ran.length - 1];
  if (calls.length === 1) return last;
  const line = (r: (typeof ran)[number]) => `${r.call}: ${r.output}`;
  const before = ran.slice(0, -1);
  const lines =
    last.exitCode === 0
      ? ran.map(line)
      : [
          before.length === 0
            ? line(last)
            : `${before.map((r) => WENT_THROUGH[r.call]).join(', ')}, then ${last.call} failed: ${last.output}`,
          ...before.map(line),
        ];
  const output = lines.join('\n');
  return { exitCode: last.exitCode, output: output.slice(0, SUMMARY_CHARS) };
}

/** Validates, records, then (unless undone) sends: nothing is ever sent unrecorded. */
export async function runAction(
  { db, operators }: Actions,
  request: ActionRequest,
  undone: boolean,
): Promise<Outcome> {
  const operator = operators.get(request.factory);
  if (!operator) return { status: 403, error: 'no operator for this factory' };
  let checked: Checked;
  try {
    checked = await checkAgainstDb(db, request, operator.login);
  } catch (error) {
    console.error('actions: database check failed', error);
    return { status: 503, error: 'the database is unavailable' };
  }
  if ('error' in checked) return checked;

  const answer = request.action === 'answer' ? request : null;
  const values = [
    request.factory,
    operator.who,
    request.action,
    'run_id' in request ? request.run_id : null,
    answer?.occurrence ?? null,
    checked.option,
    answer?.text ?? null,
    request.action === 'resume' ? request.from_step : null,
    undone,
    'number' in request ? request.number : null,
    request.action === 'comment' ? request.text : null,
  ];
  let id: number;
  try {
    const [row] = await db.query(
      `INSERT INTO mc.actions (factory, who, action, run_id, occurrence, option, answer_text, from_step, undone, item_number, comment_text, sent_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, CASE WHEN $9 THEN NULL ELSE now() END) RETURNING id::int AS id`,
      values,
    );
    id = Number(row.id);
  } catch (error) {
    console.error('actions: could not record the action; nothing was sent', error);
    return { status: 503, error: 'the action could not be recorded; nothing was sent' };
  }
  if (undone) {
    return { status: 200, result: { id, sent: false, ok: null, exit_code: null, summary: '' } };
  }
  const { exitCode, output } = await runCalls(operator, checked.calls);
  try {
    await db.query(
      'UPDATE mc.actions SET exit_code = $2, output = $3, finished_at = now() WHERE id = $1',
      [id, exitCode, output],
    );
  } catch (error) {
    console.error(`actions: sent action ${id} but could not record its result`, error);
  }
  return {
    status: 200,
    result: { id, sent: true, ok: exitCode === 0, exit_code: exitCode, summary: output },
  };
}

/** Without a database the actions cannot be recorded, so none are offered. */
export function actionsFromEnv(env: Env, repoRoot: string): Actions | undefined {
  const databaseUrl = env.MC_DATABASE_URL;
  if (!databaseUrl) return undefined;
  const operators = loadOperators(env, repoRoot, readFactoryNames(env, repoRoot));
  return { db: openDb(databaseUrl), operators };
}

export function actionsRoutes(app: Hono, actions: Actions | undefined): void {
  app.get('/api/actions', (c) => {
    const operators = [...(actions?.operators ?? [])];
    const body = {
      factories: operators.map(([name]) => name),
      logins: operators.filter(([, operator]) => operator.login !== null).map(([name]) => name),
    } satisfies OperatorsBody;
    return c.json(body);
  });
  app.post('/api/actions', async (c) => {
    if (!actions) return c.json({ error: 'actions are not configured' }, 503);
    const parsed = parseActionBody(await c.req.json().catch(() => null));
    if (typeof parsed === 'string') return c.json({ error: parsed }, 400);
    const { undone, ...request } = parsed;
    const outcome = await runAction(actions, request as ActionRequest, undone);
    if ('error' in outcome) return c.json({ error: outcome.error }, outcome.status as 403);
    return c.json(outcome.result);
  });
}
