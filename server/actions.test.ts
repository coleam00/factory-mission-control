import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { type Actions, loadOperators, parseActionBody } from './actions';
import { createApp } from './app';
import { FACTORY, FAILED_RUN, OTHER_RUN, startManagerDb, WAITING_RUN } from './manager-fixture';

const repoRoot = resolve(import.meta.dir, '..');
const STUB = join(repoRoot, 'fixtures', 'archon-stub-cli.ts');
const MESSAGE_RUN = '5eed0001-0000-4000-8000-0000000000c1';
const OTHER_OPTION_RUN = '5eed0001-0000-4000-8000-0000000000c2';

let fixture: Awaited<ReturnType<typeof startManagerDb>>;
let scratch: string;
let log: string;
let app: ReturnType<typeof createApp>;

function appWith(extraEnv: Record<string, string> = {}) {
  const operators = new Map([
    [
      FACTORY,
      {
        who: 'cole',
        command: [process.execPath, STUB],
        cwd: scratch,
        env: { MC_STUB_CLI_LOG: log, ...extraEnv },
      },
    ],
  ]);
  const actions: Actions = { db: fixture.db, operators };
  return createApp({ buildId: 'test', distDir: scratch, actions });
}

const post = (body: unknown, application = app) =>
  application.request('/api/actions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const answer = (run: string, occurrence: string, over: Record<string, unknown> = {}) => ({
  factory: FACTORY,
  action: 'answer',
  run_id: run,
  occurrence,
  option: null,
  text: null,
  undone: false,
  ...over,
});
const resume = (run: string, over: Record<string, unknown> = {}) => ({
  factory: FACTORY,
  action: 'resume',
  run_id: run,
  from_step: null,
  undone: false,
  ...over,
});

const sent = (): string[][] =>
  existsSync(log)
    ? readFileSync(log, 'utf-8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
const rows = () => fixture.direct.query('SELECT * FROM mc.actions ORDER BY id');

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'mc-actions-'));
  log = join(scratch, 'stub.log');
  fixture = await startManagerDb();
  await fixture.direct.query(
    `INSERT INTO mc.laps (run_id, factory, workflow_name, status, started_at) VALUES
       ('${MESSAGE_RUN}', '${FACTORY}', 'archon-loop', 'paused', now()),
       ('${OTHER_OPTION_RUN}', '${FACTORY}', 'archon-loop', 'paused', now());
     INSERT INTO mc.attention_items (run_id, factory, workflow_name, node_id, waiting_since, form, options, labels, message, occurrence_id) VALUES
       ('${MESSAGE_RUN}', '${FACTORY}', 'archon-loop', 'ask', now(), 'message', '[]', '{}', 'Why?', 'pause-m-1'),
       ('${OTHER_OPTION_RUN}', '${FACTORY}', 'archon-loop', 'ask', now(), 'select',
         '[{"id":"yes","label":"Ship it"},{"id":"other","label":"Something else"}]', '{}', 'Ship?', 'pause-o-1');`,
  );
  app = appWith();
});

afterAll(async () => {
  await fixture.stop();
  rmSync(scratch, { recursive: true, force: true });
});

beforeEach(async () => {
  rmSync(log, { force: true });
  await fixture.direct.query('DELETE FROM mc.actions');
});

describe('answer', () => {
  test('an option runs exactly the answer command and is recorded with its result', async () => {
    const response = await post(answer(WAITING_RUN, 'pause-ask-1', { option: 'yes' }));
    expect(await response.json()).toMatchObject({ sent: true, ok: true, exit_code: 0 });
    expect(sent()).toEqual([
      ['workflow', 'answer', WAITING_RUN, '--occurrence=pause-ask-1', '--choose=yes', '--json'],
    ]);
    const [row] = await rows();
    expect(row).toMatchObject({
      factory: FACTORY,
      who: 'cole',
      action: 'answer',
      option: 'yes',
      undone: false,
      exit_code: 0,
    });
    expect(row.sent_at).not.toBeNull();
    expect(String(row.output)).toContain('"ok":true');
  });

  test('free text goes with the declared other option, or alone on a message', async () => {
    await post(answer(OTHER_OPTION_RUN, 'pause-o-1', { text: 'do it later' }));
    await post(answer(MESSAGE_RUN, 'pause-m-1', { text: 'because' }));
    expect(sent()).toEqual([
      [
        'workflow',
        'answer',
        OTHER_OPTION_RUN,
        '--occurrence=pause-o-1',
        '--choose=other',
        '--text=do it later',
        '--json',
      ],
      ['workflow', 'answer', MESSAGE_RUN, '--occurrence=pause-m-1', '--text=because', '--json'],
    ]);
    const recorded = await rows();
    expect(recorded.map((row) => row.option)).toEqual(['other', null]);
  });

  test('the CLI inherits none of the dashboard credentials', async () => {
    const envFile = join(scratch, 'stub-env.json');
    process.env.MC_DATABASE_URL_PROBE = 'dashboard-only';
    try {
      await post(
        answer(WAITING_RUN, 'pause-ask-1', { option: 'yes' }),
        appWith({ MC_STUB_ENV_FILE: envFile }),
      );
    } finally {
      delete process.env.MC_DATABASE_URL_PROBE;
    }
    const names: string[] = JSON.parse(readFileSync(envFile, 'utf-8'));
    expect(names).toContain('MC_STUB_ENV_FILE');
    expect(names).not.toContain('MC_DATABASE_URL_PROBE');
  });

  test('text on a question with no other option is refused and never sent', async () => {
    const response = await post(answer(WAITING_RUN, 'pause-ask-1', { text: 'hm' }));
    expect(response.status).toBe(409);
    expect(sent()).toEqual([]);
    expect(await rows()).toEqual([]);
  });

  test('the other option without text is refused and never sent', async () => {
    const response = await post(answer(OTHER_OPTION_RUN, 'pause-o-1', { option: 'other' }));
    expect(response.status).toBe(409);
    expect(sent()).toEqual([]);
    expect(await rows()).toEqual([]);
  });

  test('text that looks like flags reaches the CLI as one --text element', async () => {
    const text = '--cwd=/etc --choose=no';
    await post(answer(MESSAGE_RUN, 'pause-m-1', { text }));
    expect(sent()[0]).toEqual([
      'workflow',
      'answer',
      MESSAGE_RUN,
      '--occurrence=pause-m-1',
      `--text=${text}`,
      '--json',
    ]);
  });

  test('a stale occurrence, an undeclared option, or both option and text are refused', async () => {
    const bad = [
      { option: 'yes', occurrence: 'pause-old' },
      { option: 'maybe' },
      { option: 'yes', text: 'x' },
    ];
    for (const over of bad) {
      const response = await post(answer(WAITING_RUN, 'pause-ask-1', over));
      expect(response.status).toBeGreaterThanOrEqual(400);
    }
    expect(sent()).toEqual([]);
    expect(await rows()).toEqual([]);
  });
});

describe('resume', () => {
  test('a failed run resumes detached and records the step it named', async () => {
    const response = await post(resume(FAILED_RUN, { from_step: 'implement' }));
    expect(await response.json()).toMatchObject({ sent: true, ok: true });
    expect(sent()).toEqual([['workflow', 'resume', FAILED_RUN, '--detach', '--json']]);
    expect((await rows())[0]).toMatchObject({ action: 'resume', from_step: 'implement' });
  });

  test('a step that did not fail, and a run that is not resumable, are refused', async () => {
    expect((await post(resume(FAILED_RUN, { from_step: 'review' }))).status).toBe(409);
    expect((await post(resume(OTHER_RUN))).status).toBe(409);
    expect(sent()).toEqual([]);
    expect(await rows()).toEqual([]);
  });
});

describe('undo', () => {
  test('an undone answer and an undone resume are recorded as undone and never sent', async () => {
    await post(answer(WAITING_RUN, 'pause-ask-1', { option: 'yes', undone: true }));
    await post(resume(FAILED_RUN, { undone: true }));
    expect(sent()).toEqual([]);
    const recorded = await rows();
    expect(recorded.map((row) => [row.undone, row.sent_at, row.exit_code])).toEqual([
      [true, null, null],
      [true, null, null],
    ]);
  });
});

describe('the allowlist', () => {
  test('any other verb is refused before anything runs', async () => {
    for (const action of ['approve', 'reject', 'run', 'cancel', 'abandon', 'respond', '']) {
      expect((await post({ ...resume(FAILED_RUN), action })).status).toBe(400);
    }
    expect(sent()).toEqual([]);
    expect(await rows()).toEqual([]);
  });

  test('a command, path or env in the request is refused', async () => {
    for (const key of ['command', 'cwd', 'argv', 'args', 'env', 'path']) {
      expect((await post({ ...resume(FAILED_RUN), [key]: 'x' })).status).toBe(400);
    }
    expect(sent()).toEqual([]);
  });

  test('a known factory without an operator entry is refused', async () => {
    const response = await post({ ...resume(FAILED_RUN), factory: 'other-factory' });
    expect(response.status).toBe(403);
    expect(sent()).toEqual([]);
    expect(await rows()).toEqual([]);
  });

  test('a run id that is not a UUID is refused', async () => {
    expect((await post(resume('not-a-run'))).status).toBe(400);
  });

  test('parseActionBody accepts only the two shapes', () => {
    expect(parseActionBody(resume(FAILED_RUN))).toMatchObject({ action: 'resume' });
    expect(typeof parseActionBody({ ...resume(FAILED_RUN), from_step: 7 })).toBe('string');
  });
});

test('a CLI failure is recorded with its exit status and error, and shown to the caller', async () => {
  const failing = appWith({ MC_STUB_CLI_FAIL: 'occurrence is stale' });
  const response = await post(resume(FAILED_RUN), failing);
  expect(await response.json()).toMatchObject({
    sent: true,
    ok: false,
    exit_code: 1,
    summary: 'stub refuses: occurrence is stale',
  });
  expect((await rows())[0]).toMatchObject({
    exit_code: 1,
    output: 'stub refuses: occurrence is stale',
  });
});

test('GET /api/actions names the factories with an entry and nothing else', async () => {
  const response = await app.request('/api/actions');
  const text = await response.text();
  expect(JSON.parse(text)).toEqual({ factories: [FACTORY] });
  expect(text).not.toContain(STUB);
  expect(text).not.toContain(scratch);
});

describe('loadOperators', () => {
  const entry = { who: 'cole', command: ['archon'], cwd: process.cwd() };
  const load = (config: unknown, factories = ['f']) => {
    const file = join(scratch, 'operators.json');
    writeFileSync(file, JSON.stringify(config));
    return loadOperators({ MC_OPERATORS_FILE: file }, repoRoot, factories);
  };

  test('a missing file is no entries', () => {
    const missing = { MC_OPERATORS_FILE: join(scratch, 'none.json') };
    expect(loadOperators(missing, repoRoot, ['f']).size).toBe(0);
  });

  test('a good entry loads', () => {
    expect(load({ operators: { f: entry } }).get('f')).toMatchObject({ who: 'cole', env: {} });
  });

  test('a malformed entry or an unknown factory stops the load', () => {
    for (const bad of [
      { ...entry, command: [] },
      { ...entry, command: 'archon' },
      { ...entry, cwd: 'relative/path' },
      { ...entry, env: { A: 1 } },
    ]) {
      expect(() => load({ operators: { f: bad } })).toThrow();
    }
    expect(() => load({ operators: { g: entry } })).toThrow('not a factory');
  });
});
