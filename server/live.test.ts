import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createApp } from './app';
import {
  factoryNames,
  type Live,
  liveBootScript,
  loadLiveQueries,
  REALTIME_PROTOCOL,
  realtimeUrlFor,
} from './live';
import { UnknownRewindBranch } from './rewind';

const repoRoot = resolve(import.meta.dir, '..');
const queries = loadLiveQueries(join(repoRoot, 'db', 'queries'));
let distDir: string;

beforeAll(() => {
  distDir = join(mkdtempSync(join(tmpdir(), 'mc-live-')), 'dist');
  mkdirSync(distDir, { recursive: true });
  copyFileSync(join(repoRoot, 'app', 'index.html'), join(distDir, 'index.html'));
});

afterAll(() => rmSync(resolve(distDir, '..'), { recursive: true, force: true }));

const HOME_URL = 'wss://ep-abc-123.rt.c-14.us-east-1.aws.neon.tech/';
const REWIND_URL = 'wss://ep-rewind-1.rt.c-14.us-east-1.aws.neon.tech/';
const REWIND = 'rewind-2026-10-24t11-00-00z';

/** A `Live` whose sealers record what they sealed, each under its branch's name. */
function fakeLive({ openRewind = true }: { openRewind?: boolean | (() => Promise<never>) } = {}) {
  const sealed: [string, readonly string[]][] = [];
  const sealedOn: string[] = [];
  const opened: string[] = [];
  const sealer = (branch: string, url: string) => ({
    url,
    seal: async (sql: string, params: readonly string[]) => {
      sealed.push([sql, params]);
      sealedOn.push(branch);
      return { capability: 'cap', queryFingerprint: 'fp', expiresAt: 60_000 };
    },
  });
  const live: Live = {
    factories: ['mission-control'],
    queries,
    home: sealer('home', HOME_URL),
    openRewind:
      openRewind === false
        ? undefined
        : async (name) => {
            opened.push(name);
            if (typeof openRewind === 'function') return openRewind();
            return { name, ...sealer(name, REWIND_URL) };
          },
  };
  return { app: createApp({ buildId: 'test', distDir, live }), live, sealed, sealedOn, opened };
}

const post = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

describe('POST /api/live/:name', () => {
  test('a name that is not a file in db/queries/ is a 404 and seals nothing', async () => {
    const { app, sealed } = fakeLive();
    for (const name of ['nope', '..%2Fsecrets', 'status-strip.sql', '__proto__']) {
      const res = await app.request(`/api/live/${name}`, post({ factory: 'mission-control' }));
      expect(res.status).toBe(404);
      expect(await res.text()).not.toContain('capability');
    }
    expect(sealed).toEqual([]);
  });

  test('a factory the server does not know is a 400 and seals nothing', async () => {
    const { app, sealed } = fakeLive();
    for (const body of [{ factory: 'other' }, {}, 'mission-control', null]) {
      expect((await app.request('/api/live/status-strip', post(body))).status).toBe(400);
    }
    const unparsed = await app.request('/api/live/status-strip', { method: 'POST', body: '{' });
    expect(unparsed.status).toBe(400);
    expect(sealed).toEqual([]);
  });

  test('a named query for a known factory seals that file with the factory as $1', async () => {
    const { app, sealed } = fakeLive();
    const res = await app.request('/api/live/status-strip', post({ factory: 'mission-control' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      capability: 'cap',
      queryFingerprint: 'fp',
      expiresAt: 60_000,
    });
    expect(sealed).toEqual([[queries.get('status-strip') as string, ['mission-control']]]);
  });

  test("a step panel's query seals with the step's workflow and path after the factory", async () => {
    const { app, sealed } = fakeLive();
    const body = { factory: 'mission-control', args: ['archon-loop', 'check-app'] };
    expect((await app.request('/api/live/step-yaml', post(body))).status).toBe(200);
    expect(sealed).toEqual([
      [queries.get('step-yaml') as string, ['mission-control', 'archon-loop', 'check-app']],
    ]);
  });

  test("args that do not fill the query's parameters are a 400 and seal nothing", async () => {
    const { app, sealed } = fakeLive();
    for (const [name, args] of [
      ['step-yaml', undefined],
      ['step-yaml', ['archon-loop']],
      ['step-yaml', ['archon-loop', 7]],
      ['step-yaml', 'archon-loop/check-app'],
      ['status-strip', ['archon-loop']],
    ] as const) {
      const res = await app.request(
        `/api/live/${name}`,
        post({ factory: 'mission-control', args }),
      );
      expect(res.status).toBe(400);
    }
    expect(sealed).toEqual([]);
  });

  test('a factory that is a row of mc.factories but not in the factories file is a 400', async () => {
    const { app, sealed } = fakeLive();
    const res = await app.request('/api/live/status-strip', post({ factory: 'second-factory' }));
    expect(res.status).toBe(400);
    expect(sealed).toEqual([]);
  });
});

describe('factoryNames', () => {
  test("factories.json's names, unless MC_FACTORIES_FILE names another file", () => {
    expect(factoryNames({}, repoRoot)).toEqual(
      (
        JSON.parse(readFileSync(join(repoRoot, 'factories.json'), 'utf-8')) as {
          factories: { name: string }[];
        }
      ).factories.map((f) => f.name),
    );
    const file = join(resolve(distDir, '..'), 'factories.json');
    writeFileSync(file, JSON.stringify({ factories: [{ name: 'a' }, { name: 'b' }] }));
    expect(factoryNames({ MC_FACTORIES_FILE: file }, repoRoot)).toEqual(['a', 'b']);
  });
});

describe('GET /api/live', () => {
  test('gives the browser the Realtime URL and the factory names', async () => {
    const res = await fakeLive().app.request('/api/live');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      url: HOME_URL,
      home: HOME_URL,
      factories: ['mission-control'],
      rewind: null,
    });
  });
});

/** The configuration the inline script in the page hands the app. */
function bootConfig(html: string): unknown {
  const match = /<head><script>\(function\(c\)\{.*\}\)\((\{.*\})\)<\/script>/.exec(html);
  return match ? JSON.parse(match[1] as string) : undefined;
}

describe('the page the server answers', () => {
  test('opens the Realtime socket first, with what GET /api/live answers and the subprotocol', async () => {
    const res = await fakeLive().app.request('/');
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(bootConfig(html)).toEqual({
      url: HOME_URL,
      home: HOME_URL,
      factories: ['mission-control'],
      rewind: null,
      protocol: REALTIME_PROTOCOL,
    });
    expect(html).toContain('new WebSocket(c.url,c.protocol)');
    expect(html).toContain('<div id="root"></div>');
  });

  test('a client-side route gets the same page', async () => {
    expect(bootConfig(await (await fakeLive().app.request('/runs')).text())).toBeDefined();
  });

  test('the subprotocol is the one @neon/realtime asks for', () => {
    const messages = readFileSync(
      join(repoRoot, 'node_modules/@neon/realtime/dist/client/protocol/messages.js'),
      'utf-8',
    );
    expect(messages).toContain(`const REALTIME_SUBPROTOCOL = "${REALTIME_PROTOCOL}";`);
  });

  test('a factory name cannot end the script', () => {
    const script = liveBootScript({
      url: 'wss://x/',
      home: 'wss://x/',
      factories: ['</script><b>'],
      rewind: null,
    });
    expect(script.indexOf('</script>')).toBe(script.length - '</script>'.length);
  });
});

describe('POST /api/rewind', () => {
  const rewindTo = (app: ReturnType<typeof fakeLive>['app'], branch: unknown) =>
    app.request('/api/rewind', post({ branch }));

  test('switches every seal but a home one to the branch until switched back', async () => {
    const { app, sealedOn, opened } = fakeLive();
    const res = await rewindTo(app, REWIND);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ rewind: REWIND });
    expect(opened).toEqual([REWIND]);
    expect(await (await app.request('/api/live')).json()).toEqual({
      url: REWIND_URL,
      home: HOME_URL,
      factories: ['mission-control'],
      rewind: REWIND,
    });
    await app.request('/api/live/status-strip', post({ factory: 'mission-control' }));
    await app.request(
      '/api/live/rewind-branches',
      post({ factory: 'mission-control', branch: 'home' }),
    );
    expect(sealedOn).toEqual([REWIND, 'home']);
    const html = await (await app.request('/')).text();
    expect(bootConfig(html)).toMatchObject({ url: REWIND_URL, home: HOME_URL, rewind: REWIND });

    expect(await (await rewindTo(app, null)).json()).toEqual({ rewind: null });
    await app.request('/api/live/status-strip', post({ factory: 'mission-control' }));
    expect(sealedOn).toEqual([REWIND, 'home', 'home']);
    expect(await (await app.request('/api/live')).json()).toMatchObject({
      url: HOME_URL,
      rewind: null,
    });
  });

  test('a branch that is not rewind-* is a 400 and asks Neon nothing', async () => {
    const { app, opened } = fakeLive();
    for (const branch of ['main', 'check-abc', 'rewind-', 42, {}, undefined]) {
      expect((await rewindTo(app, branch)).status).toBe(400);
    }
    expect((await app.request('/api/rewind', { method: 'POST', body: '{' })).status).toBe(400);
    expect(opened).toEqual([]);
  });

  test('without the Neon API on the server switching is a 503', async () => {
    const { app } = fakeLive({ openRewind: false });
    expect((await rewindTo(app, REWIND)).status).toBe(503);
  });

  test('an unknown branch is a 404 and any other failure a 502 without its text; both keep home', async () => {
    const unknown = fakeLive({
      openRewind: () => Promise.reject(new UnknownRewindBranch(REWIND)),
    });
    const missing = await rewindTo(unknown.app, REWIND);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: `no branch named ${REWIND}` });
    expect(unknown.live.rewind).toBeUndefined();

    const failing = fakeLive({
      openRewind: () => Promise.reject(new Error('Neon API GET failed: 500 upstream detail')),
    });
    const quiet = spyOn(console, 'error').mockImplementation(() => {});
    const failed = await rewindTo(failing.app, REWIND);
    quiet.mockRestore();
    expect(failed.status).toBe(502);
    expect(await failed.text()).not.toContain('upstream detail');
    expect(failing.live.rewind).toBeUndefined();
  });

  test('a seal for any branch but home is a 400 and seals nothing', async () => {
    const { app, sealed } = fakeLive();
    for (const branch of ['rewind', 7, null, REWIND]) {
      const res = await app.request(
        '/api/live/status-strip',
        post({ factory: 'mission-control', branch }),
      );
      expect(res.status).toBe(400);
    }
    expect(sealed).toEqual([]);
  });
});

describe('without Realtime configuration', () => {
  const app = () => createApp({ buildId: 'test', distDir });

  test('the page opens no socket', async () => {
    const html = await (await app().request('/')).text();
    expect(html).not.toContain('__MC_LIVE__');
  });

  test('every live route is 503 and health stays 200', async () => {
    expect((await app().request('/api/live')).status).toBe(503);
    const res = await app().request('/api/live/status-strip', post({ factory: 'mission-control' }));
    expect(res.status).toBe(503);
    expect((await app().request('/api/rewind', post({ branch: REWIND }))).status).toBe(503);
    expect((await app().request('/api/health')).status).toBe(200);
  });
});

describe('realtimeUrlFor', () => {
  test('puts .rt. after the endpoint id of a pooled or direct Neon host', () => {
    for (const host of ['ep-abc-123-pooler', 'ep-abc-123']) {
      const url = `postgresql://u:p@${host}.c-14.us-east-1.aws.neon.tech/factory?sslmode=require`;
      expect(realtimeUrlFor(url)).toBe('wss://ep-abc-123.rt.c-14.us-east-1.aws.neon.tech/');
    }
  });

  test('refuses a host that is not a Neon endpoint', () => {
    expect(() => realtimeUrlFor('postgresql://u:p@localhost:5432/factory')).toThrow();
  });
});
