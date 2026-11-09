/**
 * The only code that writes to a factory (PRD invariant 2): answer a paused run's question, resume
 * a run, each through that factory's own Archon CLI and each recorded in `mc.actions`.
 *
 * The two argv shapes, every part a literal, a database value or the one free `--text=`:
 *   answer  workflow answer <run> --occurrence=<id> [--choose=<option id>] [--text=<text>] --json
 *   resume  workflow resume <run> --detach --json
 * `--name=value` keeps the owner's text one argv element the CLI cannot read as another flag. The
 * command, its cwd and env come only from the operator file, never from a request.
 *
 * `from_step` is recorded, not sent: `archon workflow resume` has no step argument and re-runs the
 * step that failed, so the server accepts only that step.
 */
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { Hono } from 'hono';
import type { ActionBody, ActionRequest, ActionResult } from '../app/lib/actions';
import { ANSWER_TEXT_MAX, isAnswerText, parseChoices, resolveAnswer } from '../app/lib/attention';
import { isRunId } from '../app/lib/one-lap';
import { type Db, openDb } from '../scripts/lib/db';
import type { Env } from './check-env';
import { BASE_ENV_NAMES, pick } from './child-env';
import { isObject, readFactoryNames } from './factories';
import { RESUMABLE_STATUSES } from './manager-stream';

export interface Operator {
  who: string;
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
  const { who, command, cwd, env } = raw;
  if (typeof who !== 'string' || who === '') throw new Error(`${where}.who must be a string`);
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
  return { who, command, cwd, env: (env as Record<string, string> | undefined) ?? {} };
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

const ANSWER_KEYS = Object.keys({
  factory: true,
  action: true,
  run_id: true,
  occurrence: true,
  option: true,
  text: true,
  undone: true,
} satisfies Record<keyof Extract<ActionBody, { action: 'answer' }>, true>);
const RESUME_KEYS = Object.keys({
  factory: true,
  action: true,
  run_id: true,
  from_step: true,
  undone: true,
} satisfies Record<keyof Extract<ActionBody, { action: 'resume' }>, true>);

const boundedString = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length >= 1 && value.length <= max;
const nullOrBounded = (value: unknown, max: number): value is string | null =>
  value === null || boundedString(value, max);

/** The strict allowlist: exactly the keys of one of the two actions, nothing else; a string is the refusal reason. */
export function parseActionBody(body: unknown): ActionBody | string {
  if (!isObject(body)) return 'the body must be a JSON object';
  const keys =
    body.action === 'answer' ? ANSWER_KEYS : body.action === 'resume' ? RESUME_KEYS : null;
  if (!keys) return 'action must be answer or resume';
  const extra = Object.keys(body).filter((key) => !keys.includes(key));
  const missing = keys.filter((key) => !(key in body));
  if (extra.length > 0) return `not accepted: ${extra.join(', ')}`;
  if (missing.length > 0) return `missing: ${missing.join(', ')}`;
  if (!boundedString(body.factory, 200)) return 'factory must be a string';
  if (typeof body.run_id !== 'string' || !isRunId(body.run_id)) return 'run_id must be a run id';
  if (typeof body.undone !== 'boolean') return 'undone must be a boolean';
  const common = { factory: body.factory, run_id: body.run_id.toLowerCase(), undone: body.undone };
  if (body.action === 'resume') {
    if (!nullOrBounded(body.from_step, 200)) return 'from_step must be a step id or null';
    return { ...common, action: 'resume', from_step: body.from_step };
  }
  if (!boundedString(body.occurrence, 200)) return 'occurrence must be a string';
  if (!nullOrBounded(body.option, 200)) return 'option must be an option id or null';
  if (body.text !== null && !isAnswerText(body.text))
    return `text must be 1-${ANSWER_TEXT_MAX} characters or null`;
  if ((body.option === null) === (body.text === null)) return 'send exactly one of option and text';
  return {
    ...common,
    action: 'answer',
    occurrence: body.occurrence,
    option: body.option,
    text: body.text,
  };
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

type Checked = { argvTail: string[]; option: string | null } | { status: 409; error: string };

/** Checks a request against the database; the argv is built from its row, not from the request. */
export async function checkAgainstDb(db: Db, request: ActionRequest): Promise<Checked> {
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
    return { argvTail: ['workflow', 'resume', request.run_id, '--detach', '--json'], option: null };
  }
  const [row] = await db.query(
    'SELECT form, options::text AS options, occurrence_id FROM mc.attention_items WHERE factory = $1 AND run_id::text = $2',
    [request.factory, request.run_id],
  );
  if (!row || row.occurrence_id !== request.occurrence) {
    return { status: 409, error: 'the question is no longer open' };
  }
  const resolved = resolveAnswer(
    { form: String(row.form), options: parseChoices(String(row.options)) },
    request,
  );
  if ('error' in resolved) return { status: 409, error: resolved.error };
  const option = resolved.option;
  const text = request.text === null ? [] : [`--text=${request.text}`];
  return {
    argvTail: [
      'workflow',
      'answer',
      request.run_id,
      `--occurrence=${row.occurrence_id}`,
      ...(option === null ? [] : [`--choose=${option}`]),
      ...text,
      '--json',
    ],
    option,
  };
}

/** The CLI's own error when it printed one, else its output; at most 2000 characters. */
export function summarize(stdout: string, stderr: string): string {
  const last = stdout.trim().split('\n').pop() ?? '';
  let text = stdout.trim() || stderr.trim();
  try {
    const reply: unknown = JSON.parse(last);
    if (isObject(reply) && typeof reply.error === 'string') text = reply.error;
  } catch {
    // Not JSON: the output itself is the summary.
  }
  return text.slice(0, SUMMARY_CHARS);
}

export type Outcome = { status: 200; result: ActionResult } | { status: number; error: string };

async function spawnCli(operator: Operator, argvTail: string[]) {
  try {
    const child = Bun.spawn([...operator.command, ...argvTail], {
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
    checked = await checkAgainstDb(db, request);
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
    request.run_id,
    answer?.occurrence ?? null,
    checked.option,
    answer?.text ?? null,
    request.action === 'resume' ? request.from_step : null,
    undone,
  ];
  let id: number;
  try {
    const [row] = await db.query(
      `INSERT INTO mc.actions (factory, who, action, run_id, occurrence, option, answer_text, from_step, undone, sent_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CASE WHEN $9 THEN NULL ELSE now() END) RETURNING id::int AS id`,
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
  const { exitCode, output } = await spawnCli(operator, checked.argvTail);
  try {
    await db.query('UPDATE mc.actions SET exit_code = $2, output = $3 WHERE id = $1', [
      id,
      exitCode,
      output,
    ]);
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
  app.get('/api/actions', (c) => c.json({ factories: [...(actions?.operators.keys() ?? [])] }));
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
