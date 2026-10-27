import { afterAll, beforeAll, expect, test } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { NeonApi } from '../scripts/lib/neon';
import { createApp } from './app';
import { liveFromEnv, rewindOpener } from './live';
import { rewindRealtime } from './rewind';

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
  live.openRewind = rewindOpener(fakeNeon().api, 'factory');
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
  const opened = await rewindOpener(api, 'factory')(REWIND);
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
  await expect(rewindRealtime(api, 'check-abc')).rejects.toThrow("refusing branch 'check-abc'");
  expect(calls).toEqual([]);
});
