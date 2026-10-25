import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createApp } from './app';
import { type Live, loadLiveQueries, realtimeUrlFor } from './live';

const repoRoot = resolve(import.meta.dir, '..');
const queries = loadLiveQueries(join(repoRoot, 'db', 'queries'));
let distDir: string;

beforeAll(() => {
  distDir = join(mkdtempSync(join(tmpdir(), 'mc-live-')), 'dist');
  mkdirSync(distDir, { recursive: true });
  copyFileSync(join(repoRoot, 'app', 'index.html'), join(distDir, 'index.html'));
});

afterAll(() => rmSync(resolve(distDir, '..'), { recursive: true, force: true }));

function fakeLive() {
  const sealed: [string, string][] = [];
  const live: Live = {
    url: 'wss://ep-abc-123.rt.c-14.us-east-1.aws.neon.tech/',
    factories: ['mission-control'],
    queries,
    seal: async (sql, factory) => {
      sealed.push([sql, factory]);
      return { capability: 'cap', queryFingerprint: 'fp', expiresAt: 60_000 };
    },
  };
  return { app: createApp({ buildId: 'test', distDir, live }), sealed };
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

  test('a factory not in factories.json is a 400 and seals nothing', async () => {
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
    expect(sealed).toEqual([[queries.get('status-strip') as string, 'mission-control']]);
  });
});

describe('GET /api/live', () => {
  test('gives the browser the Realtime URL and the factory names', async () => {
    const res = await fakeLive().app.request('/api/live');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      url: 'wss://ep-abc-123.rt.c-14.us-east-1.aws.neon.tech/',
      factories: ['mission-control'],
    });
  });
});

describe('without Realtime configuration', () => {
  const app = () => createApp({ buildId: 'test', distDir });

  test('both live routes are 503 and health stays 200', async () => {
    expect((await app().request('/api/live')).status).toBe(503);
    const res = await app().request('/api/live/status-strip', post({ factory: 'mission-control' }));
    expect(res.status).toBe(503);
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
