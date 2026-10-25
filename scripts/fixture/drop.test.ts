import { afterEach, expect, test } from 'bun:test';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { CHECK_ENV_FILE } from '../../server/check-env';
import { hoursAgo, NOW, recordingDeps, scratchRepo } from '../lib/test-deps';
import { branchesToDrop, main } from './drop';

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
  { id: 'br-rewind', name: 'rewind-2026-10-20T00:00Z', created_at: hoursAgo(96) },
  { id: 'br-old', name: 'check-old', created_at: hoursAgo(4) },
  { id: 'br-new', name: 'check-new', created_at: hoursAgo(1) },
  { id: 'br-abc', name: 'check-abc', created_at: hoursAgo(1 / 6) },
];

test("deletes this checkout's branch and every check-* branch older than 3 hours", async () => {
  const repoRoot = repo({ MC_CHECK_BRANCH: 'check-abc' });
  const run = recordingDeps({ repoRoot, branches: BRANCHES });
  expect(await main([], run.deps)).toBe(0);
  expect(run.mutatingCalls).toEqual(['deleteBranch check-old', 'deleteBranch check-abc']);
  expect(existsSync(join(repoRoot, CHECK_ENV_FILE))).toBe(false);
});

test("a stale branch that fails to delete does not stop this checkout's own", async () => {
  const repoRoot = repo({ MC_CHECK_BRANCH: 'check-abc' });
  const run = recordingDeps({
    repoRoot,
    branches: BRANCHES,
    throwsOn: ['deleteBranch check-old'],
  });
  expect(await main([], run.deps)).toBe(1);
  expect(run.mutatingCalls).toEqual(['deleteBranch check-old', 'deleteBranch check-abc']);
  expect(run.out).toEqual(['deleted check-abc']);
  expect(run.err.join('\n')).toContain('could not delete check-old');
  expect(existsSync(join(repoRoot, CHECK_ENV_FILE))).toBe(false);
});

test('keeps the env file when its own branch fails to delete', async () => {
  const repoRoot = repo({ MC_CHECK_BRANCH: 'check-abc' });
  const run = recordingDeps({
    repoRoot,
    branches: BRANCHES,
    throwsOn: ['deleteBranch check-abc'],
  });
  expect(await main([], run.deps)).toBe(1);
  expect(run.out).toEqual(['deleted check-old']);
  expect(existsSync(join(repoRoot, CHECK_ENV_FILE))).toBe(true);
});

test.each(['main', 'fixture', 'rewind-x'])(
  'refuses MC_CHECK_BRANCH=%s before any Neon call',
  async (name) => {
    const repoRoot = repo({ MC_CHECK_BRANCH: name });
    const run = recordingDeps({ repoRoot, branches: BRANCHES });
    expect(await main([], run.deps)).not.toBe(0);
    expect(run.neonCalls).toEqual([]);
    expect(run.err.join('\n')).toContain(`refusing branch '${name}'`);
    expect(existsSync(join(repoRoot, CHECK_ENV_FILE))).toBe(true);
  },
);

test.each([[['--help']], [['-h']]])('prints usage for %j without touching Neon', async (argv) => {
  const repoRoot = repo({ MC_CHECK_BRANCH: 'check-abc' });
  const run = recordingDeps({ repoRoot, branches: BRANCHES });
  expect(await main(argv, run.deps)).toBe(0);
  expect(run.out.join('\n')).toContain('usage: bun run fixture:drop');
  expect(run.neonCalls).toEqual([]);
  expect(existsSync(join(repoRoot, CHECK_ENV_FILE))).toBe(true);
});

test.each([[['--all']], [['check-old']], [['--help', 'x']]])(
  'exits 2 for %j without touching Neon',
  async (argv) => {
    const repoRoot = repo({ MC_CHECK_BRANCH: 'check-abc' });
    const run = recordingDeps({ repoRoot, branches: BRANCHES });
    expect(await main(argv, run.deps)).toBe(2);
    expect(run.err.join('\n')).toContain('usage: bun run fixture:drop');
    expect(run.neonCalls).toEqual([]);
    expect(existsSync(join(repoRoot, CHECK_ENV_FILE))).toBe(true);
  },
);

const WITH_MARKERS = [
  { id: 'br-main', name: 'main', created_at: hoursAgo(72) },
  { id: 'br-fixture', name: 'fixture', created_at: hoursAgo(48) },
  { id: 'br-abc', name: 'check-abc', created_at: hoursAgo(1 / 6) },
  { id: 'br-old', name: 'check-old', created_at: hoursAgo(4) },
  { id: 'br-new', name: 'check-new', created_at: hoursAgo(1) },
  { id: 'br-marker', name: 'check-abc-stale-1a2b3c4d', created_at: hoursAgo(1 / 60) },
  { id: 'br-foreign-marker', name: 'check-xyz-stale-5e6f7a8b', created_at: hoursAgo(1 / 60) },
  { id: 'br-abcd', name: 'check-abcd', created_at: hoursAgo(1 / 60) },
];

test("selects only this checkout's branch, its stale marker and stale check branches", () => {
  expect(branchesToDrop(WITH_MARKERS, 'check-abc', NOW).map((branch) => branch.name)).toEqual([
    'check-abc',
    'check-old',
    'check-abc-stale-1a2b3c4d',
  ]);
});

test('a stale marker is young to every checkout but its own', () => {
  expect(branchesToDrop(WITH_MARKERS, undefined, NOW).map((branch) => branch.name)).toEqual([
    'check-old',
  ]);
  expect(branchesToDrop(WITH_MARKERS, 'check-new', NOW).map((branch) => branch.name)).toEqual([
    'check-old',
    'check-new',
  ]);
});

test("deletes this checkout's stale marker and says so", async () => {
  const repoRoot = repo({ MC_CHECK_BRANCH: 'check-abc' });
  const run = recordingDeps({ repoRoot, branches: WITH_MARKERS });
  expect(await main([], run.deps)).toBe(0);
  expect(run.mutatingCalls).toEqual([
    'deleteBranch check-abc',
    'deleteBranch check-old',
    'deleteBranch check-abc-stale-1a2b3c4d',
  ]);
  expect(run.out).toContain('deleted check-abc-stale-1a2b3c4d');
});

const SELECTION = [
  { id: 'br-main', name: 'main', created_at: hoursAgo(72) },
  { id: 'br-fixture', name: 'fixture', created_at: hoursAgo(48) },
  { id: 'br-rewind', name: 'rewind-2026-10-20T00:00Z', created_at: hoursAgo(96) },
  { id: 'br-abc', name: 'check-abc', created_at: hoursAgo(1 / 6) },
  { id: 'br-marker', name: 'check-abc-stale-1a2b3c4d', created_at: hoursAgo(1 / 60) },
  { id: 'br-old', name: 'check-old', created_at: hoursAgo(4) },
  { id: 'br-new', name: 'check-new', created_at: hoursAgo(1) },
];

test('--dry-run lists what a drop would delete and deletes nothing', async () => {
  const repoRoot = repo({ MC_CHECK_BRANCH: 'check-abc' });
  const run = recordingDeps({ repoRoot, branches: SELECTION });
  expect(await main(['--dry-run'], run.deps)).toBe(0);
  expect(run.mutatingCalls).toEqual([]);
  expect(run.neonCalls.filter((call) => call.startsWith('deleteBranch'))).toEqual([]);
  expect(existsSync(join(repoRoot, CHECK_ENV_FILE))).toBe(true);
  expect(run.out).toEqual([
    'would delete check-abc',
    'would delete check-abc-stale-1a2b3c4d',
    'would delete check-old',
  ]);
  expect(run.out).toEqual(
    branchesToDrop(SELECTION, 'check-abc', NOW).map((branch) => `would delete ${branch.name}`),
  );
});

test('--dry-run without MC_CHECK_BRANCH lists only check-* branches older than 3 hours', async () => {
  const repoRoot = repo();
  const run = recordingDeps({ repoRoot, branches: SELECTION });
  expect(await main(['--dry-run'], run.deps)).toBe(0);
  expect(run.mutatingCalls).toEqual([]);
  expect(run.out).toEqual(['would delete check-old']);
});

test('--dry-run with nothing stale and no MC_CHECK_BRANCH lists nothing and exits 0', async () => {
  const repoRoot = repo();
  const run = recordingDeps({
    repoRoot,
    branches: SELECTION.filter((b) => b.name !== 'check-old'),
  });
  expect(await main(['--dry-run'], run.deps)).toBe(0);
  expect(run.mutatingCalls).toEqual([]);
  expect(run.out).toEqual([]);
});

test.each(['main', 'fixture', 'rewind-x'])(
  '--dry-run refuses MC_CHECK_BRANCH=%s before any Neon call',
  async (name) => {
    const repoRoot = repo({ MC_CHECK_BRANCH: name });
    const run = recordingDeps({ repoRoot, branches: SELECTION });
    expect(await main(['--dry-run'], run.deps)).not.toBe(0);
    expect(run.neonCalls).toEqual([]);
    expect(run.err.join('\n')).toContain(`refusing branch '${name}'`);
  },
);

test.each([[['--dry-run', 'x']], [['x', '--dry-run']]])(
  'exits 2 for %j and names --dry-run in the usage',
  async (argv) => {
    const repoRoot = repo({ MC_CHECK_BRANCH: 'check-abc' });
    const run = recordingDeps({ repoRoot, branches: SELECTION });
    expect(await main(argv, run.deps)).toBe(2);
    expect(run.err.join('\n')).toContain('bun run fixture:drop --dry-run');
    expect(run.neonCalls).toEqual([]);
  },
);
