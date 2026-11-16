import { afterAll, beforeAll, expect, test } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import pg from 'pg';
import { ARCHON_TABLES } from '../db/test-db';
import { pgliteDb } from '../scripts/lib/pglite';
import { migrationsDir, readMigrationFiles, runMigrations } from '../scripts/migrate';
import { createApp } from './app';
import { liveBootScript, liveConfig, localLive, parameterCount } from './live';
import { poolRunner } from './local-live';

const repoRoot = resolve(import.meta.dir, '..');
const FACTORY = 'mission-control';
const env = { MC_FACTORIES_FILE: '' };

let lite: PGlite;
let server: PGLiteSocketServer;
let pool: pg.Pool;
let distDir: string;

beforeAll(async () => {
  lite = new PGlite();
  await pgliteDb(lite).query(ARCHON_TABLES);
  await runMigrations({ files: readMigrationFiles(migrationsDir(repoRoot)), db: pgliteDb(lite) });
  server = new PGLiteSocketServer({ db: lite, port: 0, host: '127.0.0.1', maxConnections: 5 });
  await server.start();
  pool = new pg.Pool({
    connectionString: `postgres://postgres@${server.getServerConn()}/postgres`,
    max: 1,
  });
  distDir = join(mkdtempSync(join(tmpdir(), 'mc-local-')), 'dist');
  mkdirSync(distDir, { recursive: true });
  copyFileSync(join(repoRoot, 'app', 'index.html'), join(distDir, 'index.html'));
});

afterAll(async () => {
  await pool.end();
  await server.stop();
  await lite.close();
  rmSync(resolve(distDir, '..'), { recursive: true, force: true });
});

function app() {
  const live = localLive(env, repoRoot, poolRunner(pool));
  return { live, app: createApp({ buildId: 'test', distDir, live }) };
}

function post(a: ReturnType<typeof createApp>, path: string, body: unknown) {
  return a.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('a local seal names the query and parameters, carries no secret, and the rows route runs it', async () => {
  const { live, app: a } = app();
  const name = [...live.queries.keys()].find(
    (q) => parameterCount(live.queries.get(q) ?? '') === 1,
  );
  if (!name) throw new Error('no single-parameter query');
  const sealRes = await post(a, `/api/live/${name}`, { factory: FACTORY });
  expect(sealRes.status).toBe(200);
  const sealed = (await sealRes.json()) as Record<string, unknown>;
  expect(sealed.local).toEqual({ query: name, params: [FACTORY] });
  expect(sealed.rewind).toBeNull();
  expect(sealed.expiresAt as number).toBeGreaterThan(Date.now() + 60_000);
  expect(JSON.stringify(sealed)).not.toContain('postgres://');

  const rowsRes = await post(a, '/api/live-rows', sealed.local);
  expect(rowsRes.status).toBe(200);
  const answer = (await rowsRes.json()) as { rows: unknown[]; timestamps: string[] };
  expect(Array.isArray(answer.rows)).toBe(true);
  expect(Array.isArray(answer.timestamps)).toBe(true);
});

test('the rows route refuses unknown queries, factories and argument counts', async () => {
  const { live, app: a } = app();
  const name = [...live.queries.keys()].find(
    (q) => parameterCount(live.queries.get(q) ?? '') === 1,
  );
  expect((await post(a, '/api/live-rows', { query: 'nope', params: [FACTORY] })).status).toBe(404);
  expect((await post(a, '/api/live-rows', { query: name, params: ['other'] })).status).toBe(400);
  expect((await post(a, '/api/live-rows', { query: name, params: [FACTORY, 'x'] })).status).toBe(
    400,
  );
  expect((await post(a, '/api/live-rows', { query: name })).status).toBe(400);
});

test('queries run read-only with a 5 s statement timeout', async () => {
  const run = poolRunner(pool);
  expect((await run('SHOW statement_timeout', [])).rows).toEqual([{ statement_timeout: '5s' }]);
  expect((await run('SHOW transaction_read_only', [])).rows).toEqual([
    { transaction_read_only: 'on' },
  ]);
  await expect(run('CREATE TABLE mc.local_write_probe (x int)', [])).rejects.toThrow();
  // The connection is usable after the failure: the transaction was rolled back.
  expect((await run('SELECT 1 AS one', [])).rows).toEqual([{ one: 1 }]);
});

test('timestamp and date columns are named so the browser can revive them', async () => {
  const run = poolRunner(pool);
  const out = await run(
    "SELECT timestamptz '2026-11-16 10:00:00+00' AS at, date '2026-11-16' AS day, 1 AS n",
    [],
  );
  expect(out.timestamps).toEqual(['at']);
  expect(out.dates).toEqual(['day']);
  expect(out.rows[0]?.day).toBe('2026-11-16');
});

test('rewind is unavailable in local mode', async () => {
  const { app: a } = app();
  expect((await post(a, '/api/rewind', { branch: 'rewind-x' })).status).toBe(503);
  expect((await a.request('/api/rewind/branches')).status).toBe(503);
});

test('local config says local, and the boot script opens no WebSocket', async () => {
  const { live, app: a } = app();
  expect(liveConfig(live).mode).toBe('local');
  const script = liveBootScript(liveConfig(live));
  expect(script).not.toContain('WebSocket');
  expect(script).toContain('"mode":"local"');
  const page = await (await a.request('/')).text();
  expect(page).toContain('window.__MC_LIVE__=');
  expect(page).not.toContain('WebSocket');
});
