import { afterAll, beforeAll, describe, expect, setDefaultTimeout, spyOn, test } from 'bun:test';
import { join } from 'node:path';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { ANSWER_TEXT_MAX } from '../app/lib/attention';
import { ATTENTION_SOURCES, attentionCount } from '../app/lib/attention-page';
import { lapHref } from '../app/lib/one-lap';
import { snapshot } from '../db/test-db';
import { createApp } from './app';
import { loadLiveQueries } from './live';
import {
  type AgentRunner,
  type AttentionTally,
  attentionLine,
  briefingQuestion,
  CREDENTIAL_NAMES,
  createManager,
  type Manager,
  managerSettings,
} from './manager';
import {
  ELSEWHERE_FAILED,
  ELSEWHERE_WAITING,
  FACTORY,
  FAILED_RUN,
  type ManagerDb,
  OTHER_RUN,
  startManagerDb,
  TEXT_RUN,
  WAITING_RUN,
} from './manager-fixture';
import {
  LINK_KINDS,
  MAX_PROPOSALS,
  MAX_RUNS,
  type ManagerEvent,
  PROPOSAL_ACTIONS,
  parseBlock,
} from './manager-stream';

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
    { kind: 'run', id: ELSEWHERE_FAILED },
    { kind: 'item', id: 600 },
  ],
  runs: [FAILED_RUN, ghost, OTHER_RUN, ELSEWHERE_FAILED],
  proposals: [
    // Another factory's runs, a finished run, an unknown step and an unknown option are all dropped.
    { action: 'answer', run_id: ELSEWHERE_WAITING, option: 'yes' },
    { action: 'resume', run_id: ELSEWHERE_FAILED },
    { action: 'resume', run_id: OTHER_RUN },
    { action: 'resume', run_id: FAILED_RUN, from_step: 'nope' },
    { action: 'answer', run_id: WAITING_RUN, option: 'maybe' },
    { action: 'resume', run_id: ghost },
    { action: 'answer', run_id: WAITING_RUN, option: 'yes' },
    { action: 'answer', run_id: TEXT_RUN, text: 'Something else' },
    { action: 'resume', run_id: FAILED_RUN, from_step: 'implement' },
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
    errors: [`stopped: ${subtype}`],
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
      'proposal',
      'done',
    ]);
    expect(got[0]).toEqual({ type: 'text', text: 'Two things need you.\n' });
    expect(got.filter((e) => e.type === 'link')).toMatchObject([
      { kind: 'run', id: FAILED_RUN, href: lapHref(FACTORY, FAILED_RUN) },
      { kind: 'item', id: 514, href: `/f/${FACTORY}/work/514` },
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
        occurrence: 'pause-ask-1',
        option: 'yes',
        text: null,
        label: 'Answer "Ship it"',
        detail: 'Ship it',
      },
      {
        type: 'proposal',
        action: 'answer',
        factory: FACTORY,
        run_id: TEXT_RUN,
        occurrence: 'pause-ask-3',
        option: null,
        text: 'Something else',
        label: 'Answer with your text',
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

  test('a run stopped by what is left of the day says the day is spent', async () => {
    const played = model(async () => [
      start,
      delta('Partial'),
      result(0.2, 'error_max_budget_usd'),
    ]);
    const got = await events(
      await chat(managerOf(played, { MC_MANAGER_DAY_USD: '0.2', MC_MANAGER_MESSAGE_USD: '0.5' })),
    );
    expect(played.options[0]?.maxBudgetUsd).toBe(0.2);
    expect(got.find((e) => e.type === 'notice')).toMatchObject({ kind: 'day-cap' });
  });

  test('drops a proposal whose action is neither answer nor resume', async () => {
    const block = JSON.stringify({
      proposals: [
        { action: 'cancel', run_id: FAILED_RUN },
        { action: 'delete', run_id: FAILED_RUN },
      ],
    });
    const played = model(async () => [
      start,
      delta(`Done.
${FENCE}mc
${block}
${FENCE}
`),
      result(0.01),
    ]);
    const got = await events(await chat(managerOf(played)));
    expect(got.filter((e) => e.type === 'proposal')).toEqual([]);
  });

  test('a temp dir that cannot be removed does not turn the answer into a failure', async () => {
    const fs = await import('node:fs');
    const played = model(async () => [start, delta('fine'), result(0.01)]);
    const log = spyOn(console, 'error').mockImplementation(() => {});
    const blocked = spyOn(fs, 'rmSync').mockImplementation(() => {
      throw new Error('EBUSY');
    });
    try {
      const got = await events(await chat(managerOf(played)));
      expect(got.map((e) => e.type)).toEqual(['text', 'done']);
      expect(log).toHaveBeenCalledWith(expect.stringContaining('EBUSY'));
    } finally {
      blocked.mockRestore();
      log.mockRestore();
    }
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

describe('the day cap', () => {
  /** A model that stays in flight until `release()`. */
  function held(cost: number) {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const played = model(async () => {
      await gate;
      return [start, delta('ok'), result(cost)];
    });
    return { played, release };
  }
  const started = async (played: Played, count: number) => {
    while (played.prompts.length < count) await Bun.sleep(10);
  };

  test('is shared by requests in flight together', async () => {
    clock = new Date('2026-11-08T10:00:00');
    const { played, release } = held(0.01);
    const manager = managerOf(played, {
      MC_MANAGER_MESSAGE_USD: '0.1',
      MC_MANAGER_DAY_USD: '0.15',
    });
    const first = chat(manager).then(events);
    await started(played, 1);
    const second = chat(manager).then(events);
    await started(played, 2);
    const third = await events(await chat(manager));
    expect(played.options.map((o) => o.maxBudgetUsd)).toEqual([0.1, expect.closeTo(0.05, 5)]);
    expect(third.map((e) => e.type)).toEqual(['notice', 'done']);
    expect(third[0]).toMatchObject({ kind: 'day-cap' });
    release();
    await Promise.all([first, second]);
  });

  test('counts the ceiling of a run the client abandoned', async () => {
    clock = new Date('2026-11-08T10:00:00');
    const played = model(async () => []);
    played.run = ({ prompt, options }) => {
      played.prompts.push(prompt);
      return (async function* () {
        yield start;
        await new Promise((_, reject) =>
          options.abortController?.signal.addEventListener('abort', () =>
            reject(new Error('aborted')),
          ),
        );
      })();
    };
    const gone = new AbortController();
    const app = createApp({ buildId: 't', distDir: '.', manager: managerOf(played) });
    const pending = Promise.resolve(
      app.request('/api/manager/chat', {
        method: 'POST',
        signal: gone.signal,
        body: JSON.stringify({
          factory: FACTORY,
          context: { place: 'runs' },
          messages: [{ role: 'owner', text: 'what failed today?' }],
        }),
      }),
    ).then(events);
    await started(played, 1);
    gone.abort();
    expect((await pending).at(-1)).toMatchObject({
      type: 'done',
      cost_usd: 0.5,
      day_spent_usd: 0.5,
    });
  });
});

describe('a run that does not succeed', () => {
  test('is logged, because the notice sends the owner to the log', async () => {
    const log = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const got = await events(
        await chat(managerOf(model(async () => [start, result(0.01, 'error_max_turns')]))),
      );
      expect(got.map((e) => e.type)).toEqual(['notice', 'done']);
      expect(log).toHaveBeenCalledWith(expect.stringContaining('error_max_turns'));
    } finally {
      log.mockRestore();
    }
  });

  test('names the missing credential when none is set', async () => {
    const kept = { ...process.env };
    const failing = () => model(async () => [start, result(0, 'error_during_execution')]);
    const log = spyOn(console, 'error').mockImplementation(() => {});
    try {
      for (const name of CREDENTIAL_NAMES) delete process.env[name];
      const without = await chat(managerOf(failing()));
      const text = await without.text();
      for (const name of CREDENTIAL_NAMES) expect(text).toContain(name);
      // Runs that never reach the model spend nothing, so they never fill the day cap.
      const never = managerOf(
        model(async () => []),
        { MC_MANAGER_DAY_USD: '1' },
      );
      for (let i = 0; i < 5; i++) {
        const body = await (await chat(never)).text();
        expect(body).toContain('CLAUDE_CODE_OAUTH_TOKEN');
        expect(body).toContain('"day_spent_usd":0');
      }
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'token';
      const withToken = await chat(managerOf(failing()));
      expect(await withToken.text()).not.toContain('CLAUDE_CODE_OAUTH_TOKEN');
    } finally {
      log.mockRestore();
      for (const name of CREDENTIAL_NAMES) {
        if (kept[name] === undefined) delete process.env[name];
        else process.env[name] = kept[name];
      }
    }
  });
});

describe('over a real server', () => {
  test('an answer that is silent for longer than the idle timeout still arrives', async () => {
    const played = model(async () => {
      await Bun.sleep(4000);
      return [start, delta('late'), result(0.01)];
    });
    const app = createApp({ buildId: 't', distDir: '.', manager: managerOf(played) });
    const server = Bun.serve({ port: 0, idleTimeout: 1, fetch: app.fetch });
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/manager/chat`, {
        method: 'POST',
        body: JSON.stringify({
          factory: FACTORY,
          context: { place: 'runs' },
          messages: [{ role: 'owner', text: 'hello' }],
        }),
      });
      expect((await events(res)).map((e) => e.type)).toEqual(['text', 'done']);
    } finally {
      await server.stop(true);
    }
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
    const samples = { MC_DATABASE_URL: 'postgres://sample-db', NEON_API_KEY: 'neon_sample_key' };
    const kept = { ...process.env };
    Object.assign(process.env, samples);
    try {
      const played = answering();
      const body = await (await chat(managerOf(played))).text();
      const options = played.options[0] as Options;
      const cli = JSON.stringify(options.env);
      const { mc } = options.mcpServers as Record<string, { env: Record<string, string> }>;
      for (const value of [fixture.url, ...Object.values(samples)]) {
        expect(cli).not.toContain(value);
        expect(body).not.toContain(value);
        expect(JSON.stringify(mc?.env)).not.toContain(samples.NEON_API_KEY);
      }
      expect(Object.keys(options.env ?? {}).filter((k) => /DATABASE|NEON/.test(k))).toEqual([]);
      expect(mc?.env.MC_DATABASE_URL).toBe(fixture.url);
    } finally {
      for (const name of Object.keys(samples)) {
        if (kept[name] === undefined) delete process.env[name];
        else process.env[name] = kept[name];
      }
    }
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

  const briefingOf = (manager: Manager) => async (refresh?: boolean) =>
    events(
      await createApp({ buildId: 't', distDir: '.', manager }).request('/api/manager/briefing', {
        method: 'POST',
        body: JSON.stringify({ factory: FACTORY, refresh }),
      }),
    );

  test('opens with the count Attention shows, from the same rows', async () => {
    clock = new Date('2026-11-08T10:00:00');
    const F = 'briefed';
    const run = (n: number) => `5eed0009-0000-4000-8000-0000000000${n}`;
    await fixture.direct.query(
      `INSERT INTO mc.factories (name, repository, codebase, console) VALUES ('${F}', 'o/b', 'o/b', 'http://localhost:3092');
       INSERT INTO mc.issues (factory, number, title, state, url, created_at, updated_at)
         VALUES ('${F}', 9, 'Ask the owner', 'open', 'https://github.com/o/b/issues/9', now(), now());
       INSERT INTO mc.issue_labels (factory, issue_number, label) VALUES ('${F}', 9, 'needs-owner');
       INSERT INTO mc.capacity_waits (run_id, factory, workflow_name, item_number, since) VALUES
         ('${run(11)}', '${F}', 'archon-build', 7, now()), ('${run(12)}', '${F}', 'archon-build', 8, now());
       INSERT INTO mc.run_stops (run_id, factory, workflow_name, status, step_id, line, class, signature, stopped_at) VALUES
         ('${run(21)}', '${F}', 'archon-build', 'failed', 'implement', 'boom', 'code', 'sig-a', now()),
         ('${run(22)}', '${F}', 'archon-build', 'failed', 'implement', 'boom', 'code', 'sig-a', now()),
         ('${run(23)}', '${F}', 'archon-merge', 'failed', 'gate', 'nope', 'config', 'sig-b', now())`,
    );
    try {
      const queries = loadLiveQueries(join(import.meta.dir, '..', 'db', 'queries'));
      const sources = await Promise.all(
        Object.values(ATTENTION_SOURCES).map(async ({ query }) => ({
          state: 'ready' as const,
          rows: await fixture.direct.query(queries.get(query) ?? '', [F]),
        })),
      );
      const count = attentionCount(sources);
      expect(count).toBe(5);
      const played = model(async () => [start, delta('fine'), result(0.01)]);
      const manager = createManager({
        db: fixture.direct,
        databaseUrl: fixture.url,
        factories: [F],
        settings: managerSettings({}),
        run: played.run,
        now: () => clock,
      });
      const ask = async () =>
        events(
          await createApp({ buildId: 't', distDir: '.', manager }).request(
            '/api/manager/briefing',
            { method: 'POST', body: JSON.stringify({ factory: F }) },
          ),
        );
      const line = `No run is paused on a question. ${count} things need you: 1 to decide, 2 to unstick, 2 to fix (3 failures in 2 causes).`;
      expect((await ask())[0]).toEqual({ type: 'text', text: `${line}\n\n` });
      expect(played.prompts[0]).toContain(line);
      // The first generation is handed the rows the line was counted from, not left to query for them.
      expect(played.prompts[0]).toContain('Ask the owner');
      expect(played.prompts[0]).toContain(run(11));
      expect(played.prompts[0]).toContain(run(23));

      expect((await ask())[0]).toEqual({ type: 'text', text: `${line}\n\n` });
      expect(played.prompts).toHaveLength(1);

      await fixture.direct.query(
        `INSERT INTO mc.capacity_waits (run_id, factory, workflow_name, item_number, since) VALUES ('${run(13)}', '${F}', 'archon-build', 9, now())`,
      );
      const changed = await ask();
      expect(changed[0]).toMatchObject({ text: expect.stringContaining('6 things need you') });
      expect(changed.at(-1)).toMatchObject({ type: 'done', cached: false });
      expect(played.prompts).toHaveLength(2);
      expect(played.prompts[1]).toContain('6 things need you');
    } finally {
      await fixture.direct.query(
        `DELETE FROM mc.capacity_waits WHERE factory = '${F}';
         DELETE FROM mc.run_stops WHERE factory = '${F}';
         DELETE FROM mc.issue_labels WHERE factory = '${F}';
         DELETE FROM mc.issues WHERE factory = '${F}';
         DELETE FROM mc.factories WHERE name = '${F}'`,
      );
    }
  });

  test('a request that joins a briefing written against another count gets prose for its own', async () => {
    clock = new Date('2026-11-08T10:00:00');
    const F = 'joined';
    const wait = (n: number) =>
      `INSERT INTO mc.capacity_waits (run_id, factory, workflow_name, item_number, since) VALUES ('5eed0009-0000-4000-8000-0000000000${n}', '${F}', 'archon-build', ${n}, now())`;
    await fixture.direct.query(
      `INSERT INTO mc.factories (name, repository, codebase, console) VALUES ('${F}', 'o/b', 'o/b', 'http://localhost:3092');
       ${wait(11)}`,
    );
    try {
      let release = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const played = model(async () => {
        await gate;
        return [start, delta('fine'), result(0.01)];
      });
      const manager = createManager({
        db: fixture.direct,
        databaseUrl: fixture.url,
        factories: [F],
        settings: managerSettings({}),
        run: played.run,
        now: () => clock,
      });
      const ask = async () =>
        events(
          await createApp({ buildId: 't', distDir: '.', manager }).request(
            '/api/manager/briefing',
            { method: 'POST', body: JSON.stringify({ factory: F }) },
          ),
        );
      const first = ask();
      while (played.prompts.length === 0) await new Promise((r) => setTimeout(r, 10));
      await fixture.direct.query(wait(12));
      const second = ask();
      await new Promise((r) => setTimeout(r, 300));
      release();
      const [a, b] = await Promise.all([first, second]);
      expect(a[0]).toMatchObject({ text: expect.stringContaining('1 thing needs you') });
      expect(b[0]).toMatchObject({ text: expect.stringContaining('2 things need you') });
      expect(played.prompts).toHaveLength(2);
      expect(played.prompts[1]).toContain('2 things need you');
    } finally {
      await fixture.direct.query(
        `DELETE FROM mc.capacity_waits WHERE factory = '${F}'; DELETE FROM mc.factories WHERE name = '${F}'`,
      );
    }
  });

  test('sends nothing, the count line included, while the model is still writing', async () => {
    clock = new Date('2026-11-08T10:00:00');
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const played = model(async () => {
      await gate;
      return [start, delta('fine'), result(0.01)];
    });
    const response = await createApp({
      buildId: 't',
      distDir: '.',
      manager: managerOf(played),
    }).request('/api/manager/briefing', {
      method: 'POST',
      body: JSON.stringify({ factory: FACTORY }),
    });
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const first = reader.read();
    const early = await Promise.race([
      first.then(() => 'chunk'),
      new Promise((resolve) => setTimeout(() => resolve('silent'), 300)),
    ]);
    release();
    await first;
    await reader.cancel();
    expect(early).toBe('silent');
  });

  test('the line names each group by its count', () => {
    const tally = (t: Partial<AttentionTally>): AttentionTally => ({
      decide: 0,
      owner: 0,
      unstick: 0,
      failures: 0,
      failureRuns: 0,
      ...t,
    });
    expect(attentionLine(tally({}))).toBe('Nothing needs you.');
    expect(attentionLine(tally({ unstick: 2, failures: 1, failureRuns: 1 }))).toBe(
      'No question is waiting. 3 things need you: 2 to unstick, 1 to fix (1 failure in 1 cause).',
    );
    expect(attentionLine(tally({ decide: 1 }))).toBe(
      '1 run is paused on your answer. 1 thing needs you: 1 to decide.',
    );
  });

  test('a failed briefing is not kept for the day', async () => {
    clock = new Date('2026-11-08T10:00:00');
    const log = spyOn(console, 'error').mockImplementation(() => {});
    let calls = 0;
    const played = model(async () => {
      if (calls++ === 0) throw new Error('boom');
      return [start, delta('fine'), result(0.01)];
    });
    const ask = briefingOf(managerOf(played));
    try {
      expect((await ask()).map((e) => e.type)).toEqual(['text', 'notice', 'done']);
    } finally {
      log.mockRestore();
    }
    expect((await ask()).at(-1)).toMatchObject({ cached: false });
    expect((await ask()).at(-1)).toMatchObject({ cached: true });
  });

  test('two askers at once share one generation', async () => {
    clock = new Date('2026-11-08T10:00:00');
    const played = model(async () => {
      await Bun.sleep(200);
      return [start, delta('fine'), result(0.01)];
    });
    const ask = briefingOf(managerOf(played));
    const both = await Promise.all([ask(), ask()]);
    expect(played.prompts).toHaveLength(1);
    expect(both.map((got) => got.at(-1))).toMatchObject([{ type: 'done' }, { type: 'done' }]);
  });

  test('is made again the next day', async () => {
    clock = new Date('2026-11-08T10:00:00');
    const played = answering();
    const ask = briefingOf(managerOf(played));
    await ask();
    clock = new Date('2026-11-09T10:00:00');
    expect((await ask()).at(-1)).toMatchObject({ cached: false });
    expect(played.prompts).toHaveLength(2);
  });
});

describe('the viewing line', () => {
  test('names the step, workflow and work order the request carries', async () => {
    for (const [context, line] of [
      [
        { place: 'step', workflow: 'archon-loop', step: 'review one' },
        'looking at step "review one" of workflow "archon-loop"',
      ],
      [{ place: 'board', order: 'v3' }, 'looking at work order "v3"'],
    ] as const) {
      const played = model(async () => [start, delta('fine'), result(0.01)]);
      await (await chat(managerOf(played), { context })).text();
      expect(played.options[0].systemPrompt as string).toContain(line);
    }
  });
});

describe('the prompt’s example block', () => {
  test('parses into every link kind and proposal action the parser accepts', async () => {
    const played = model(async () => [start, delta('fine'), result(0.01)]);
    await (await chat(managerOf(played))).text();
    const prompt = played.options[0].systemPrompt as string;
    const block = prompt.match(/```mc\n([\s\S]*?)\n```/)?.[1] ?? '';
    const parsed = parseBlock(block.replace('<issue number>', '7'));
    expect<string[]>([...new Set(parsed.links.map((link) => link.kind))].sort()).toEqual(
      Object.keys(LINK_KINDS).sort(),
    );
    expect<string[]>(
      [...new Set(parsed.proposals.map((proposal) => proposal.action))].sort(),
    ).toEqual(Object.keys(PROPOSAL_ACTIONS).sort());
    expect(parsed.runs).toHaveLength(1);
    for (const key of Object.keys(parsed.proposals[0])) {
      expect(
        parsed.proposals.some((proposal) => proposal[key as keyof typeof proposal] !== undefined),
      ).toBe(true);
    }
  });
});

describe('a lap that started on an earlier day and failed today', () => {
  const OVERNIGHT = '5eed0003-0000-4000-8000-00000000000b';

  test('is reached by the prompt rule in a chat answer and in the briefing', async () => {
    clock = new Date('2026-11-08T10:00:00');
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    await fixture.direct.query(
      `INSERT INTO mc.laps (run_id, factory, workflow_name, status, started_at, completed_at)
         VALUES ('${OVERNIGHT}', '${FACTORY}', 'archon-loop', 'failed',
                 '2026-10-24T08:00:00Z', '${new Date('2026-11-08T03:00:00').toISOString()}')`,
    );
    try {
      const played = model(async () => [start, delta('fine'), result(0.01)]);
      const manager = managerOf(played);
      await (await chat(manager)).text();
      const briefed = await createApp({ buildId: 't', distDir: '.', manager }).request(
        '/api/manager/briefing',
        { method: 'POST', body: JSON.stringify({ factory: FACTORY, refresh: true }) },
      );
      await briefed.text();
      expect(played.options).toHaveLength(2);
      for (const options of played.options) {
        expect(options.systemPrompt as string).toContain(
          'filter on completed_at, never started_at',
        );
        expect(options.systemPrompt as string).toContain(
          `(completed_at AT TIME ZONE '${zone}')::date = DATE '2026-11-08'`,
        );
      }
      expect(played.prompts[1]).toContain('completed_at');

      const [byCompletion] = await callTools(played.options[0], [
        [
          'select',
          {
            sql: `SELECT run_id FROM mc.laps WHERE factory = '${FACTORY}' AND status = 'failed' AND (completed_at AT TIME ZONE '${zone}')::date = DATE '2026-11-08'`,
          },
        ],
      ]);
      expect(JSON.stringify(byCompletion)).toContain(OVERNIGHT);
    } finally {
      await fixture.direct.query(`DELETE FROM mc.laps WHERE run_id = '${OVERNIGHT}'`);
    }
  });
});

describe('a structure lookup that fails', () => {
  test('ends the answer with a notice, not a silent done', async () => {
    const failing = Object.create(fixture.direct);
    failing.transaction = async () => {
      throw new Error('statement timeout');
    };
    const manager = { ...managerOf(answering()), db: failing };
    const got = await events(await chat(manager));
    const types = got.map((e) => e.type);
    expect(types.slice(-2)).toEqual(['notice', 'done']);
    expect(got.find((e) => e.type === 'notice')).toMatchObject({
      kind: 'unstructured',
      text: expect.stringContaining('links and buttons'),
    });
  });
});

describe('the briefing question with a run paused and other Attention rows', () => {
  test('hands the model the opening line and forbids a count or a mismatch claim of its own', () => {
    const tally = { decide: 1, owner: 3, unstick: 0, failures: 0, failureRuns: 0 };
    const question = briefingQuestion(tally);
    expect(question).toContain(attentionLine(tally));
    expect(question).toContain('4 things need you');
    expect(question).toContain('State no number of Attention items');
    expect(question).toContain('never say the rows or the opening line disagree');
    expect(question).not.toContain('count a run');
  });
});

describe('a briefing whose count cannot be read', () => {
  test('states no count rather than "Nothing needs you"', async () => {
    const log = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const failing = Object.create(fixture.direct);
      failing.transaction = async () => {
        throw new Error('statement timeout');
      };
      const played = model(async () => [start, delta('fine'), result(0.01)]);
      const manager = { ...managerOf(played), db: failing };
      const res = await createApp({ buildId: 't', distDir: '.', manager }).request(
        '/api/manager/briefing',
        { method: 'POST', body: JSON.stringify({ factory: FACTORY, refresh: true }) },
      );
      const got = await events(res);
      expect(got[0]).toMatchObject({ type: 'text', text: 'fine' });
      expect(JSON.stringify(got)).not.toContain('need you');
      expect(played.prompts[0]).toContain('could not be read');
    } finally {
      log.mockRestore();
    }
  });

  test('never replays a cached body across a count that was or is unreadable', async () => {
    const log = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const failing = Object.create(fixture.direct);
      failing.transaction = async () => {
        throw new Error('statement timeout');
      };
      const played = model(async () => [start, delta('fine'), result(0.01)]);
      const manager = managerOf(played);
      const ask = async (db: Manager['db']) => {
        const res = await createApp({
          buildId: 't',
          distDir: '.',
          manager: { ...manager, db },
        }).request('/api/manager/briefing', {
          method: 'POST',
          body: JSON.stringify({ factory: FACTORY }),
        });
        return (await events(res)).at(-1);
      };
      await ask(fixture.direct);
      expect(await ask(failing)).toMatchObject({ cached: false });
      expect(await ask(failing)).toMatchObject({ cached: false });
      expect(await ask(fixture.direct)).toMatchObject({ cached: false });
      expect(played.prompts).toHaveLength(4);
    } finally {
      log.mockRestore();
    }
  });
});

describe('request validation', () => {
  test.each([
    ['an unknown factory', { factory: 'nope' }],
    ['a bad place', { context: { place: 'moon' } }],
    ['a bad run', { context: { place: 'run', run: 'x' } }],
    ['an unknown context field', { context: { place: 'step', phase: 'x' } }],
    ['a prototype-named context field', { context: { place: 'run', constructor: 'x' } }],
    ['a step with a line break', { context: { place: 'step', step: 'a\nb' } }],
    ['an over-long order', { context: { place: 'board', order: 'x'.repeat(101) } }],
    ['a non-string workflow', { context: { place: 'step', workflow: 7 } }],
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

describe('the settings', () => {
  test('refuse a bad cap or effort and default when unset', () => {
    expect(() => managerSettings({ MC_MANAGER_DAY_USD: 'abc' })).toThrow('MC_MANAGER_DAY_USD');
    expect(() => managerSettings({ MC_MANAGER_MESSAGE_USD: '0' })).toThrow(
      'MC_MANAGER_MESSAGE_USD',
    );
    expect(() => managerSettings({ MC_MANAGER_DAY_USD: '-1' })).toThrow('MC_MANAGER_DAY_USD');
    expect(() => managerSettings({ MC_MANAGER_EFFORT: 'turbo' })).toThrow('MC_MANAGER_EFFORT');
    expect(managerSettings({})).toEqual({
      model: 'claude-sonnet-5-5',
      effort: 'low',
      messageCapUsd: 0.5,
      dayCapUsd: 5,
    });
  });
});

describe('a proposal the action endpoint would refuse', () => {
  test('is dropped: a bare Something else, text on a choice question, text over the cap', async () => {
    const structure = {
      proposals: [
        { action: 'answer', run_id: TEXT_RUN, option: 'other' },
        { action: 'answer', run_id: WAITING_RUN, text: 'my own words' },
        { action: 'answer', run_id: TEXT_RUN, text: 'x'.repeat(ANSWER_TEXT_MAX + 1) },
        { action: 'answer', run_id: TEXT_RUN, text: 'x'.repeat(ANSWER_TEXT_MAX) },
      ],
    };
    const played = model(async () => [
      start,
      delta(`${FENCE}mc
${JSON.stringify(structure)}
${FENCE}
`),
      result(0.01),
    ]);
    const got = await events(await chat(managerOf(played)));
    expect(got.filter((e) => e.type === 'proposal')).toMatchObject([
      { run_id: TEXT_RUN, option: null, text: 'x'.repeat(ANSWER_TEXT_MAX) },
    ]);
  });
});

describe('the caps on one answer', () => {
  const EXTRA = Array.from(
    { length: MAX_RUNS + 1 },
    (_, i) => `5eed0004-0000-4000-8000-${String(i).padStart(12, '0')}`,
  );

  test('keep four backed proposals to three and a longer run list to the run cap', async () => {
    await fixture.direct.query(
      `INSERT INTO mc.laps (run_id, factory, workflow_name, status, started_at, completed_at)
         VALUES ${EXTRA.map((id) => `('${id}', '${FACTORY}', 'archon-loop', 'completed', now(), now())`).join(',')}`,
    );
    try {
      const structure = {
        runs: EXTRA,
        proposals: [
          { action: 'answer', run_id: WAITING_RUN, option: 'yes' },
          { action: 'answer', run_id: WAITING_RUN, option: 'no' },
          { action: 'answer', run_id: TEXT_RUN, text: 'Something else' },
          { action: 'resume', run_id: FAILED_RUN },
        ],
      };
      const played = model(async () => [
        start,
        delta(`\`\`\`mc\n${JSON.stringify(structure)}\n${FENCE}\n`),
        result(0.01),
      ]);
      const got = await events(await chat(managerOf(played)));
      expect(got.filter((e) => e.type === 'proposal')).toHaveLength(MAX_PROPOSALS);
      const runs = got.find((e) => e.type === 'runs');
      expect(runs?.type === 'runs' && runs.runs).toHaveLength(MAX_RUNS);
    } finally {
      await fixture.direct.query(`DELETE FROM mc.laps WHERE run_id IN ('${EXTRA.join("','")}')`);
    }
  });
});
