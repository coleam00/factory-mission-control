import { afterAll, beforeAll, expect, test } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Db, Row } from '../scripts/lib/db';
import type { NeonApi } from '../scripts/lib/neon';
import { createApp } from './app';
import { liveFromEnv, rewindOpener } from './live';
import { rewindBranchNames, rewindListed, rewindRealtime, UnlistedRewindBranch } from './rewind';

const repoRoot = resolve(import.meta.dir, '..');
const REWIND = 'rewind-2026-10-24t11-00-00z';
const PASSWORD = 'home-password-0123';
const CONNECTION = `postgresql://owner:${PASSWORD}@ep-home-1-pooler.c-14.us-east-1.aws.neon.tech/factory?sslmode=require`;
/** `createRealtime` takes only a well-formed secret: `nrt_live_1` and 32 bytes in base64url. */
const secret = () =>
  `nrt_live_1${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')}`;
const HOME_SECRET = secret();
const REWIND_SECRET = secret();

/** A Neon project holding the rewind branch; every request is recorded. */
function fakeNeon() {
  const calls: string[] = [];
  const unused = (name: string) => () => Promise.reject(new Error(`${name} is not used`));
  const api: NeonApi = {
    async listBranches() {
      calls.push('listBranches');
      return [{ id: 'br-rewind', name: REWIND, created_at: '' }];
    },
    async branchEndpoints(branchId) {
      calls.push(`branchEndpoints ${branchId}`);
      return [
        {
          id: 'ep-rewind-1',
          branch_id: branchId,
          host: 'ep-rewind-1.c-14.us-east-1.aws.neon.tech',
          current_state: 'active',
        },
      ];
    },
    async getRealtimeSecret(branchId) {
      calls.push(`getRealtimeSecret ${branchId}`);
      return REWIND_SECRET;
    },
    getBranch: unused('getBranch'),
    getEndpoint: unused('getEndpoint'),
    getOperation: unused('getOperation'),
    getRealtime: unused('getRealtime'),
    pooledConnectionUri: unused('pooledConnectionUri'),
    createBranch: unused('createBranch'),
    deleteBranch: unused('deleteBranch'),
    createRewindBranch: unused('createRewindBranch'),
    deleteRewindBranch: unused('deleteRewindBranch'),
  };
  return { api, calls };
}

const listed = async () => true;

let distDir: string;

beforeAll(() => {
  distDir = join(mkdtempSync(join(tmpdir(), 'mc-rewind-')), 'dist');
  mkdirSync(distDir, { recursive: true });
  copyFileSync(join(repoRoot, 'app', 'index.html'), join(distDir, 'index.html'));
});

afterAll(() => rmSync(resolve(distDir, '..'), { recursive: true, force: true }));

const post = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

test('neither the list, the switch nor any page answer carries a secret or connection string', async () => {
  const live = liveFromEnv(
    { MC_DATABASE_URL: CONNECTION, NEON_REALTIME_SECRET: HOME_SECRET },
    repoRoot,
  );
  if (!live) throw new Error('liveFromEnv gave no live configuration');
  live.openRewind = rewindOpener(fakeNeon().api, 'factory', listed);
  const app = createApp({ buildId: 'test', distDir, live });

  const answers = [
    await app.request('/api/rewind', post({ branch: REWIND })),
    await app.request('/api/live'),
    await app.request(
      '/api/live/rewind-branches',
      post({ factory: 'mission-control', branch: 'home' }),
    ),
    await app.request('/api/live/status-strip', post({ factory: 'mission-control' })),
    await app.request('/rewind'),
  ];
  expect(answers.map((res) => res.status)).toEqual([200, 200, 200, 200, 200]);
  const bodies = await Promise.all(answers.map((res) => res.text()));
  expect(bodies[1]).toContain('wss://ep-rewind-1.rt.c-14.us-east-1.aws.neon.tech/');
  for (const body of bodies) {
    for (const leak of ['postgres', PASSWORD, HOME_SECRET, REWIND_SECRET, 'nrt_live']) {
      expect(body).not.toContain(leak);
    }
  }
});

test('an opened rewind branch is its name, its Realtime URL and a sealer, nothing else', async () => {
  const { api, calls } = fakeNeon();
  const opened = await rewindOpener(api, 'factory', listed)(REWIND);
  expect(Object.keys(opened).sort()).toEqual(['name', 'seal', 'url']);
  expect(opened.url).toBe('wss://ep-rewind-1.rt.c-14.us-east-1.aws.neon.tech/');
  expect(calls).toEqual([
    'listBranches',
    'branchEndpoints br-rewind',
    'getRealtimeSecret br-rewind',
  ]);
});

test('a branch that is not rewind-* is refused before any Neon request', async () => {
  const { api, calls } = fakeNeon();
  await expect(rewindRealtime(api, 'check-abc', listed)).rejects.toThrow(
    "refusing branch 'check-abc'",
  );
  expect(calls).toEqual([]);
});

test('a rewind-* branch the list does not show is refused before any Neon request', async () => {
  const { api, calls } = fakeNeon();
  const refused = rewindRealtime(api, REWIND, async () => false);
  await expect(refused).rejects.toBeInstanceOf(UnlistedRewindBranch);
  await expect(refused).rejects.toThrow(`${REWIND} is not in the rewind list`);
  expect(calls).toEqual([]);
});

test('the branches Neon has are its rewind-* names only', async () => {
  const { api } = fakeNeon();
  api.listBranches = async () => [
    { id: 'br-main', name: 'main', created_at: '' },
    { id: 'br-check', name: 'check-abc', created_at: '' },
    { id: 'br-rewind', name: REWIND, created_at: '' },
  ];
  expect(await rewindBranchNames(api)).toEqual([REWIND]);
});

test('the list is one query on mc.rewind_branches, and its connection closes after each answer', async () => {
  const ran: { url: string; sql: string; params: unknown[] | undefined }[] = [];
  let closed = 0;
  const openWith =
    (rows: Row[]) =>
    (url: string): Db => ({
      async query(sql, params) {
        ran.push({ url, sql, params });
        return rows;
      },
      transaction: () => Promise.reject(new Error('transaction is not used')),
      async close() {
        closed += 1;
      },
    });
  expect(await rewindListed(CONNECTION, openWith([{ '?column?': 1 }]))(REWIND)).toBe(true);
  expect(await rewindListed(CONNECTION, openWith([]))(REWIND)).toBe(false);
  const query = {
    url: CONNECTION,
    sql: 'SELECT 1 FROM mc.rewind_branches WHERE name = $1',
    params: [REWIND],
  };
  expect(ran).toEqual([query, query]);
  expect(closed).toBe(2);
});
