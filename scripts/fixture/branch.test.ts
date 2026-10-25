import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CHECK_ENV_FILE, parseCheckEnv } from '../../server/check-env';
import { CREATED_URL, hoursAgo, recordingDeps, scratchRepo } from '../lib/test-deps';
import { main } from './branch';

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function repo(checkEnv?: Record<string, string>): string {
  const dir = scratchRepo(checkEnv);
  scratch.push(dir);
  return dir;
}

const BRANCHES = [
  { id: 'br-main', name: 'main', created_at: hoursAgo(72) },
  { id: 'br-fixture', name: 'fixture', created_at: hoursAgo(48) },
];

test('forks check-<8 hex> from fixture, seeds it and writes the env file', async () => {
  const repoRoot = repo();
  mkdirSync(join(repoRoot, 'fixtures'));
  writeFileSync(join(repoRoot, 'fixtures', 'seed.sql'), 'INSERT INTO seeded VALUES (1);');
  const run = recordingDeps({ repoRoot, branches: BRANCHES });
  expect(await main([], run.deps)).toBe(0);

  const env = parseCheckEnv(readFileSync(join(repoRoot, CHECK_ENV_FILE), 'utf-8'));
  expect(Object.keys(env).sort()).toEqual([
    'MC_CHECK_BRANCH',
    'MC_DATABASE_URL',
    'NEON_REALTIME_SECRET',
  ]);
  expect(env.MC_CHECK_BRANCH).toMatch(/^check-[0-9a-f]{8}$/);
  expect(env.MC_DATABASE_URL).toBe(CREATED_URL);
  expect(env.NEON_REALTIME_SECRET).toBe('nrt_live_1fake');
  expect(run.mutatingCalls).toEqual([`createBranch ${env.MC_CHECK_BRANCH} from br-fixture`]);
  expect(run.opened).toEqual([CREATED_URL]);
  expect(run.sql).toContain('INSERT INTO seeded VALUES (1);');
  expect(run.out).toContain(`created ${env.MC_CHECK_BRANCH}`);
});

test('refuses before any Neon call when the env file already names a branch', async () => {
  const repoRoot = repo({ MC_CHECK_BRANCH: 'check-abc' });
  const run = recordingDeps({ repoRoot, branches: BRANCHES });
  expect(await main([], run.deps)).toBe(1);
  expect(run.neonCalls).toEqual([]);
  expect(run.err.join('\n')).toContain('already names check-abc');
});

test('creates nothing when the project has no fixture branch', async () => {
  const run = recordingDeps({ repoRoot: repo(), branches: [BRANCHES[0]] });
  expect(await main([], run.deps)).toBe(1);
  expect(run.mutatingCalls).toEqual([]);
});

test('deletes the new branch and writes no env file when a later step fails', async () => {
  const repoRoot = repo();
  const run = recordingDeps({
    repoRoot,
    branches: BRANCHES,
    throwsOn: ['getRealtimeSecret br-new'],
  });
  expect(await main([], run.deps)).toBe(1);
  const [create, ...rest] = run.mutatingCalls;
  const name = create.split(' ')[1];
  expect(rest).toEqual([`deleteBranch ${name}`]);
  expect(run.opened).toEqual([]);
  expect(existsSync(join(repoRoot, CHECK_ENV_FILE))).toBe(false);
});

test.each([[['--help']], [['--name', 'check-mine']]])('creates nothing for %j', async (argv) => {
  const run = recordingDeps({ repoRoot: repo(), branches: BRANCHES });
  expect(await main(argv, run.deps)).toBe(argv[0] === '--help' ? 0 : 2);
  expect([...run.out, ...run.err].join('\n')).toContain('usage: bun run fixture:branch');
  expect(run.neonCalls).toEqual([]);
});
