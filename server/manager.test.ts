import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { snapshot } from '../db/test-db';
import { createApp } from './app';
import { type AgentRunner, createManager, type Manager, managerSettings } from './manager';
import {
  FACTORY,
  FAILED_RUN,
  type ManagerDb,
  OTHER_RUN,
  startManagerDb,
  WAITING_RUN,
} from './manager-fixture';
import type { ManagerEvent } from './manager-stream';

// Each answer that calls a tool starts a `bun` subprocess, which takes seconds on Windows.
setDefaultTimeout(30_000);

let fixture: ManagerDb;
beforeAll(async () => {
  fixture = await startManagerDb();
}, 60_000);
afterAll(() => fixture.stop());

const ghost = '5eed0001-0000-4000-8000-0000000000ff';
const STRUCTURE = {
  links: [
    { kind: 'run', id: FAILED_RUN },
    { kind: 'item', id: 514 },
    { kind: 'item', id: 9999 },
  ],
  runs: [FAILED_RUN, ghost, OTHER_RUN],
  proposals: [
    { action: 'answer', run_id: WAITING_RUN, option: 'yes' },
    { action: 'answer', run_id: WAITING_RUN, option: 'maybe' },
    { action: 'resume', run_id: FAILED_RUN, from_step: 'implement' },
    { action: 'resume', run_id: ghost },
  ],
};

const delta = (text: string) =>
  ({
    type: 'stream_event',
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
  }) as unknown as SDKMessage;
const start = { type: 'stream_event', event: { type: 'message_start' } } as unknown as SDKMessage;
const result = (cost: number, subtype = 'success') =>
  ({
    type: 'result',
    subtype,
    is_error: subtype !== 'success',
    total_cost_usd: cost,
  }) as unknown as SDKMessage;

/** Calls the tool server `options` names, as the CLI would. */
async function callTools(options: Options, calls: [string, object][]) {
  const server = options.mcpServers?.mc as {
    command: string;
    args: string[];
    env: Record<string, string>;
  };
  const child = Bun.spawn([server.command, ...server.args], {
    env: server.env,
    stdin: 'pipe',
    stdout: 'pipe',
  });
  calls.forEach(([name, args], i) => {
    const request = {
      jsonrpc: '2.0',
      id: i,
      method: 'tools/call',
      params: { name, arguments: args },
    };
    child.stdin.write(`${JSON.stringify(request)}\n`);
  });
  await child.stdin.end();
  const out = await new Response(child.stdout).text();
  return out
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line).result);
}

interface Played {
  prompts: string[];
  options: Options[];
  run: AgentRunner;
}

function model(play: (options: Options) => Promise<SDKMessage[]>): Played {
  const played: Played = {
    prompts: [],
    options: [],
    run: ({ prompt, options }) => {
      played.prompts.push(prompt);
      played.options.push(options);
      return (async function* () {
        for (const message of await play(options)) yield message;
      })();
    },
  };
  return played;
}

const FENCE = '```';
const answering = (cost = 0.01) =>
  model(async (options) => {
    await callTools(options, [
      ['select', { sql: 'DELETE FROM mc.laps' }],
      ['live_query', { name: 'attention-items' }],
    ]);
    return [
      start,
      delta('Two things need you.\n``'),
      delta(`\`mc\n${JSON.stringify(STRUCTURE)}\n${FENCE}\n`),
      result(cost),
    ];
  });

let clock = new Date('2026-11-08T10:00:00');
function managerOf(played: Played, settings: Record<string, string> = {}): Manager {
  return createManager({
    // In-process: the tool subprocess holds the socket's session, and two Bun clients on one
    // PGlite session collide on prepared statement names.
    db: fixture.direct,
    databaseUrl: fixture.url,
    factories: [FACTORY],
    settings: managerSettings(settings),
    run: played.run,
    now: () => clock,
  });
}

const chat = async (manager: Manager, body: object = {}): Promise<Response> =>
  createApp({ buildId: 't', distDir: '.', manager }).request('/api/manager/chat', {
    method: 'POST',
    body: JSON.stringify({
      factory: FACTORY,
      context: { place: 'runs' },
      messages: [{ role: 'owner', text: 'what failed today?' }],
      ...body,
    }),
  });

async function events(res: Response): Promise<ManagerEvent[]> {
  return (await res.text())
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
}

describe('the chat endpoint against a stubbed model', () => {
  test('streams text, links, a run list and proposals in the documented shape', async () => {
    const played = answering();
    const before = await snapshot(fixture.direct);
    const res = await chat(managerOf(played));
    expect(res.headers.get('content-type')).toBe('application/x-ndjson; charset=utf-8');
    const got = await events(res);
    expect(got.map((e) => e.type)).toEqual([
      'text',
      'link',
      'link',
      'runs',
      'proposal',
      'proposal',
      'done',
    ]);
    expect(got[0]).toEqual({ type: 'text', text: 'Two things need you.\n' });
    expect(got.filter((e) => e.type === 'link')).toMatchObject([
      { kind: 'run', id: FAILED_RUN, href: `/f/${FACTORY}/laps/${FAILED_RUN}` },
      { kind: 'item', id: 514, label: '#514 Manager backend', href: `/f/${FACTORY}/work/514` },
    ]);
    const runs = got.find((e) => e.type === 'runs');
    expect(runs?.type === 'runs' && runs.runs.map((r) => r.run_id)).toEqual([
      FAILED_RUN,
      OTHER_RUN,
    ]);
    expect(got.filter((e) => e.type === 'proposal')).toEqual([
      {
        type: 'proposal',
        action: 'answer',
        factory: FACTORY,
        run_id: WAITING_RUN,
        occurrence: 'ask',
        option: 'yes',
        text: null,
        label: 'Answer "Ship it"',
      },
      {
        type: 'proposal',
        action: 'resume',
        factory: FACTORY,
        run_id: FAILED_RUN,
        from_step: 'implement',
        label: 'Resume from implement',
      },
    ]);
    expect(got.at(-1)).toEqual({
      type: 'done',
      cost_usd: 0.01,
      day_spent_usd: 0.01,
      day_cap_usd: 5,
    });
    expect(played.prompts[0]).toBe('Owner: what failed today?');
    expect(await snapshot(fixture.direct)).toEqual(before);
  });

  test('the agent has no tool but the two read tools, and the write it tried was refused', async () => {
    let refused: unknown;
    const played = model(async (options) => {
      refused = await callTools(options, [['select', { sql: 'DELETE FROM mc.laps' }]]);
      return [result(0)];
    });
    await events(await chat(managerOf(played)));
    const options = played.options[0] as Options;
    expect(options).toMatchObject({
      tools: [],
      allowedTools: ['mcp__mc__live_query', 'mcp__mc__select'],
      strictMcpConfig: true,
      settingSources: [],
      persistSession: false,
    });
    expect(Object.keys(options.mcpServers ?? {})).toEqual(['mc']);
    const signal = new AbortController().signal;
    const verdict = async (name: string) =>
      (await options.canUseTool?.(name, {}, { signal, toolUseID: 't', requestId: 'r' }))?.behavior;
    expect(await Promise.all(['Bash', 'Write', 'mcp__other__x'].map(verdict))).toEqual([
      'deny',
      'deny',
      'deny',
    ]);
    expect(await Promise.all(['mcp__mc__select', 'mcp__mc__live_query'].map(verdict))).toEqual([
      'allow',
      'allow',
    ]);
    expect(refused).toMatchObject([{ isError: true }]);
  });

  test('a message over its cap says so and keeps the prose already streamed', async () => {
    const played = model(async () => [
      start,
      delta('Partial answer'),
      result(0.5, 'error_max_budget_usd'),
    ]);
    const got = await events(await chat(managerOf(played)));
    expect(got.map((e) => e.type)).toEqual(['text', 'notice', 'done']);
    expect(got[1]).toMatchObject({ kind: 'message-cap', text: expect.stringContaining('$0.50') });
  });

  test('a day cap stops the agent being called and the next day resets it', async () => {
    clock = new Date('2026-11-08T10:00:00');
    const played = model(async () => [start, delta('ok'), result(0.015)]);
    const manager = managerOf(played, { MC_MANAGER_DAY_USD: '0.02' });
    await events(await chat(manager));
    await events(await chat(manager));
    const calls = played.prompts.length;
    const got = await events(await chat(manager));
    expect(played.prompts).toHaveLength(calls);
    expect(got.map((e) => e.type)).toEqual(['notice', 'done']);
    expect(got[0]).toMatchObject({ kind: 'day-cap' });
    clock = new Date('2026-11-09T00:01:00');
    expect((await events(await chat(manager))).map((e) => e.type)).toEqual(['text', 'done']);
  });
});

describe('secrets', () => {
  const secrets = {
    NEON_REALTIME_SECRET: 'nrt_sample_secret',
    NEON_API_KEY: 'neon_sample_key',
    ANTHROPIC_API_KEY: 'sk-ant-sample',
  };

  test('a failing model gives a plain notice that carries none of them, nor the database URL', async () => {
    const played = model(async () => {
      throw new Error(`could not reach ${fixture.url} with ${secrets.ANTHROPIC_API_KEY}`);
    });
    const text = await (await chat(managerOf(played))).text();
    expect(text).toContain('"kind":"unavailable"');
    for (const value of [fixture.url, ...Object.values(secrets)]) expect(text).not.toContain(value);
  });

  test('the CLI gets no database URL or Neon key; the database URL reaches the tool server only', async () => {
    const played = answering();
    const body = await (await chat(managerOf(played))).text();
    const options = played.options[0] as Options;
    const cli = JSON.stringify(options.env);
    expect(Object.keys(options.env ?? {}).filter((k) => /DATABASE|NEON/.test(k))).toEqual([]);
    expect(cli).not.toContain(fixture.url);
    expect(body).not.toContain(fixture.url);
    const { mc } = options.mcpServers as Record<string, { env: Record<string, string> }>;
    expect(mc?.env.MC_DATABASE_URL).toBe(fixture.url);
  });
});

describe('the briefing', () => {
  test('is generated once a day, replayed from the cache, and regenerated when asked', async () => {
    clock = new Date('2026-11-08T10:00:00');
    const played = answering();
    const app = createApp({ buildId: 't', distDir: '.', manager: managerOf(played) });
    const ask = async (refresh?: boolean) =>
      events(
        await app.request('/api/manager/briefing', {
          method: 'POST',
          body: JSON.stringify({ factory: FACTORY, refresh }),
        }),
      );
    const first = await ask();
    expect(first.at(-1)).toMatchObject({ type: 'done', cached: false });
    const second = await ask();
    expect(second.at(-1)).toMatchObject({ type: 'done', cached: true, cost_usd: 0 });
    expect(second.slice(0, -1)).toEqual(first.slice(0, -1));
    expect(played.prompts).toHaveLength(1);
    await ask(true);
    expect(played.prompts).toHaveLength(2);
  });
});

describe('request validation', () => {
  test.each([
    ['an unknown factory', { factory: 'nope' }],
    ['a bad place', { context: { place: 'moon' } }],
    ['a bad run', { context: { place: 'run', run: 'x' } }],
    ['no messages', { messages: [] }],
    ['a last message from the manager', { messages: [{ role: 'manager', text: 'hi' }] }],
  ])('%s is a 400', async (_name, body) => {
    expect((await chat(managerOf(answering()), body)).status).toBe(400);
  });

  test('without a configured manager the routes answer 503', async () => {
    const app = createApp({ buildId: 't', distDir: '.' });
    for (const path of ['/api/manager/chat', '/api/manager/briefing']) {
      expect((await app.request(path, { method: 'POST', body: '{}' })).status).toBe(503);
    }
  });
});
