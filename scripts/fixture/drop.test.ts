import { afterEach, expect, test } from 'bun:test';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CHECK_ENV_FILE } from '../../server/check-env';
import { defaultLeaseDir, LEASE_MS, writeLease } from '../../server/check-lease';
import type { RunStatus } from '../lib/archon-run';
import { hoursAgo, NOW, recordingDeps, scratchRepo } from '../lib/test-deps';
import { branchesToDrop, main, STALE_MS } from './drop';

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function repo(checkEnv?: Record<string, string>): string {
  const dir = scratchRepo(checkEnv);
  scratch.push(dir);
  return dir;
}

const RUN = 'run-1f15f9a4';
const ACTIVE: RunStatus = { state: 'active' };
const ENDED: RunStatus = { state: 'ended' };

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
  expect(branchesToDrop(WITH_MARKERS, 'check-abc', NOW, []).map((branch) => branch.name)).toEqual([
    'check-abc',
    'check-old',
    'check-abc-stale-1a2b3c4d',
  ]);
});

test('a stale marker is young to every checkout but its own', () => {
  expect(branchesToDrop(WITH_MARKERS, undefined, NOW, []).map((branch) => branch.name)).toEqual([
    'check-old',
  ]);
  expect(branchesToDrop(WITH_MARKERS, 'check-new', NOW, []).map((branch) => branch.name)).toEqual([
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
    branchesToDrop(SELECTION, 'check-abc', NOW, []).map((branch) => `would delete ${branch.name}`),
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

function hoursAfter(hours: number): string {
  return new Date(NOW.getTime() + hours * 3_600_000).toISOString();
}

const YOUNG = { id: 'br-young', name: 'check-young', created_at: NOW.toISOString() };
const AT_SELECTION = [...SELECTION, YOUNG];

test.each([
  [
    hoursAfter(3 + 1 / 60),
    ['check-abc', 'check-abc-stale-1a2b3c4d', 'check-old', 'check-new', 'check-young'],
  ],
  [hoursAfter(3 - 1 / 60), ['check-abc', 'check-abc-stale-1a2b3c4d', 'check-old', 'check-new']],
])(
  '--dry-run --at %s lists what a drop then would delete and deletes nothing',
  async (at, names) => {
    const repoRoot = repo({ MC_CHECK_BRANCH: 'check-abc' });
    const run = recordingDeps({ repoRoot, branches: AT_SELECTION });
    expect(await main(['--dry-run', '--at', at], run.deps)).toBe(0);
    expect(run.mutatingCalls).toEqual([]);
    expect(run.neonCalls.filter((call) => call.startsWith('deleteBranch'))).toEqual([]);
    expect(existsSync(join(repoRoot, CHECK_ENV_FILE))).toBe(true);
    expect(run.out).toEqual(names.map((name) => `would delete ${name}`));
  },
);

test('--at goes before or after --dry-run', async () => {
  const repoRoot = repo();
  const run = recordingDeps({ repoRoot, branches: AT_SELECTION });
  expect(await main(['--at', hoursAfter(3 + 1 / 60), '--dry-run'], run.deps)).toBe(0);
  expect(run.out).toEqual([
    'would delete check-abc',
    'would delete check-abc-stale-1a2b3c4d',
    'would delete check-old',
    'would delete check-new',
    'would delete check-young',
  ]);
});

test('just under and just over 3 hours as of --at', () => {
  const at = new Date(hoursAfter(3));
  const names = (branches: typeof SELECTION) =>
    branchesToDrop(branches, undefined, at, []).map((branch) => branch.name);
  const created = (ms: number) => new Date(at.getTime() - 3 * 3_600_000 + ms).toISOString();
  expect(names([{ id: 'br-under', name: 'check-under', created_at: created(1) }])).toEqual([]);
  expect(names([{ id: 'br-at', name: 'check-at', created_at: created(0) }])).toEqual([]);
  expect(names([{ id: 'br-over', name: 'check-over', created_at: created(-1) }])).toEqual([
    'check-over',
  ]);
});

test.each([0, 1, 24, 24 * 365])(
  '--dry-run --at now + %d hours never lists a branch that is not check-*',
  async (hours) => {
    const repoRoot = repo({ MC_CHECK_BRANCH: 'check-abc' });
    const run = recordingDeps({ repoRoot, branches: AT_SELECTION });
    expect(await main(['--dry-run', '--at', hoursAfter(hours)], run.deps)).toBe(0);
    for (const line of run.out) expect(line).toMatch(/^would delete check-/);
    expect(run.out.join('\n')).not.toMatch(/main|fixture|rewind/);
  },
);

test.each([
  [['--at', hoursAfter(4)]],
  [['--at']],
  [['--dry-run', '--at']],
  [['--dry-run', '--at', 'tomorrow']],
  [['--dry-run', '--at', '2026-10-24 16:00']],
  [['--dry-run', '--at', '2026-10-24T16:00']],
  [['--dry-run', '--at', '2026-13-45T16:00Z']],
  [['--dry-run', '--at', hoursAfter(-1 / 60)]],
  [['--dry-run', '--at', hoursAfter(4), 'x']],
  [['--dry-run', '--dry-run', '--at', hoursAfter(4)]],
  [['--dry-run', '--at', hoursAfter(4), '--at', hoursAfter(5)]],
  [['--help', '--at', hoursAfter(4)]],
])('refuses %j with the usage, exit 2 and no Neon call', async (argv) => {
  const repoRoot = repo({ MC_CHECK_BRANCH: 'check-abc' });
  const run = recordingDeps({ repoRoot, branches: AT_SELECTION });
  expect(await main(argv, run.deps)).toBe(2);
  expect(run.err.join('\n')).toContain('bun run fixture:drop --dry-run --at <time>');
  expect(run.neonCalls).toEqual([]);
  expect(run.neonCalls.filter((call) => call.startsWith('deleteBranch'))).toEqual([]);
  expect(existsSync(join(repoRoot, CHECK_ENV_FILE))).toBe(true);
});

test.each([
  [['--dry-run', '--at', '2026-01-01', '--bogus']],
  [['--bogus', '--dry-run', '--at', '2026-01-01']],
  [['--at', '2026-01-01', '--bogus', '--dry-run']],
])('names the unknown argument in %j, with the usage and exit 2', async (argv) => {
  const run = recordingDeps({
    repoRoot: repo({ MC_CHECK_BRANCH: 'check-abc' }),
    branches: AT_SELECTION,
  });
  expect(await main(argv, run.deps)).toBe(2);
  expect(run.err.join('\n')).toContain('unknown argument --bogus');
  expect(run.err.join('\n')).toContain('bun run fixture:drop --dry-run --at <time>');
  expect(run.neonCalls).toEqual([]);
});

test('--at without --dry-run and nothing unknown keeps its message', async () => {
  const run = recordingDeps({
    repoRoot: repo({ MC_CHECK_BRANCH: 'check-abc' }),
    branches: AT_SELECTION,
  });
  expect(await main(['--at', hoursAfter(4)], run.deps)).toBe(2);
  expect(run.err.join('\n')).toContain('--at is only taken with --dry-run');
});

test('--dry-run --at refuses MC_CHECK_BRANCH=main before any Neon call', async () => {
  const repoRoot = repo({ MC_CHECK_BRANCH: 'main' });
  const run = recordingDeps({ repoRoot, branches: AT_SELECTION });
  expect(await main(['--dry-run', '--at', hoursAfter(4)], run.deps)).not.toBe(0);
  expect(run.neonCalls).toEqual([]);
  expect(run.err.join('\n')).toContain("refusing branch 'main'");
});

/** Checkout A owns check-abc; another checkout on this machine owns check-old, 4 hours old. */
function anotherCheckoutOwnsCheckOld(runStatus?: (run: string) => RunStatus) {
  const leaseDir = repo();
  const a = recordingDeps({
    repoRoot: repo({ MC_CHECK_BRANCH: 'check-abc' }),
    branches: BRANCHES,
    leaseDir,
    runStatus,
  });
  return { leaseDir, a, lease: (branch: string) => join(leaseDir, `${branch}.lease`) };
}

test("a running lap's old branch survives another checkout's fixture:drop", async () => {
  const { leaseDir, a, lease } = anotherCheckoutOwnsCheckOld();
  writeLease(leaseDir, 'check-old', new Date(hoursAgo(1 / 6)));
  expect(await main([], a.deps)).toBe(0);
  expect(a.mutatingCalls).toEqual(['deleteBranch check-abc']);
  expect(existsSync(lease('check-old'))).toBe(true);
});

test("a running lap's old branch survives however long it went without touching its database", async () => {
  const { leaseDir, a, lease } = anotherCheckoutOwnsCheckOld(() => ACTIVE);
  writeLease(leaseDir, 'check-old', new Date(hoursAgo(5)), RUN);
  expect(await main([], a.deps)).toBe(0);
  expect(a.mutatingCalls).toEqual(['deleteBranch check-abc']);
  expect(a.runStatusCalls).toEqual([RUN]);
  expect(existsSync(lease('check-old'))).toBe(true);

  const dry = recordingDeps({
    repoRoot: repo({ MC_CHECK_BRANCH: 'check-abc' }),
    branches: BRANCHES,
    leaseDir,
    runStatus: () => ACTIVE,
  });
  expect(await main(['--dry-run', '--at', hoursAfter(100)], dry.deps)).toBe(0);
  expect(dry.out).toEqual(['would delete check-new', 'would delete check-abc']);
});

test('a lease directory that cannot be listed stops drop before any Neon call', async () => {
  const leaseDir = join(repo(), 'not-a-dir');
  writeFileSync(leaseDir, '');
  const run = recordingDeps({
    repoRoot: repo({ MC_CHECK_BRANCH: 'check-abc' }),
    branches: BRANCHES,
    leaseDir,
  });
  expect(await main([], run.deps)).toBe(1);
  expect(run.neonCalls).toEqual([]);
  expect(run.err.join('\n')).toContain(`cannot read the leases in ${leaseDir}`);
});

test("an ended run's old branch is deleted, and its lease with it", async () => {
  const { leaseDir, a, lease } = anotherCheckoutOwnsCheckOld();
  writeLease(leaseDir, 'check-old', new Date(hoursAgo(1 + 1 / 60)));
  expect(await main([], a.deps)).toBe(0);
  expect(a.mutatingCalls).toEqual(['deleteBranch check-old', 'deleteBranch check-abc']);
  expect(existsSync(lease('check-old'))).toBe(false);
});

test("an ended run's old branch is deleted, and its lease with it, when its lease names the run", async () => {
  const { leaseDir, a, lease } = anotherCheckoutOwnsCheckOld(() => ENDED);
  writeLease(leaseDir, 'check-old', new Date(hoursAgo(5)), RUN);
  expect(await main([], a.deps)).toBe(0);
  expect(a.mutatingCalls).toEqual(['deleteBranch check-old', 'deleteBranch check-abc']);
  expect(a.runStatusCalls).toEqual([RUN]);
  expect(existsSync(lease('check-old'))).toBe(false);
});

test('an old branch is kept, with a warning, when Archon cannot say its run ended', async () => {
  const { leaseDir, a, lease } = anotherCheckoutOwnsCheckOld();
  writeLease(leaseDir, 'check-old', new Date(hoursAgo(5)), RUN);
  expect(await main([], a.deps)).toBe(0);
  expect(a.mutatingCalls).toEqual(['deleteBranch check-abc']);
  expect(existsSync(lease('check-old'))).toBe(true);
  expect(a.err.join('\n')).toContain(
    `kept check-old: cannot tell whether run ${RUN} that owns it is still running`,
  );
});

test('Archon is not asked about a recently refreshed lease, a young branch or this checkout', async () => {
  const { leaseDir, a } = anotherCheckoutOwnsCheckOld(() => ACTIVE);
  writeLease(leaseDir, 'check-old', new Date(hoursAgo(1 / 6)), RUN);
  writeLease(leaseDir, 'check-new', new Date(hoursAgo(5)), RUN);
  writeLease(leaseDir, 'check-abc', new Date(hoursAgo(5)), RUN);
  expect(await main([], a.deps)).toBe(0);
  expect(a.runStatusCalls).toEqual([]);
  expect(a.mutatingCalls).toEqual(['deleteBranch check-abc']);
});

test("this checkout's own branch is deleted whatever its lease says, and its lease with it", async () => {
  const { leaseDir, a, lease } = anotherCheckoutOwnsCheckOld();
  writeLease(leaseDir, 'check-abc', NOW);
  expect(await main([], a.deps)).toBe(0);
  expect(a.mutatingCalls).toContain('deleteBranch check-abc');
  expect(existsSync(lease('check-abc'))).toBe(false);
});

test('a branch that fails to delete keeps its lease', async () => {
  const leaseDir = repo();
  writeLease(leaseDir, 'check-abc', NOW);
  const run = recordingDeps({
    repoRoot: repo({ MC_CHECK_BRANCH: 'check-abc' }),
    branches: BRANCHES,
    leaseDir,
    throwsOn: ['deleteBranch check-abc'],
  });
  expect(await main([], run.deps)).toBe(1);
  expect(existsSync(join(leaseDir, 'check-abc.lease'))).toBe(true);
});

test('--dry-run --at judges a lease now and age at that time, and removes none', async () => {
  const listedWith = async (lease: Date | undefined, at: number) => {
    const leaseDir = repo();
    if (lease !== undefined) writeLease(leaseDir, 'check-young', lease);
    const run = recordingDeps({ repoRoot: repo(), branches: [YOUNG], leaseDir });
    expect(await main(['--dry-run', '--at', hoursAfter(at)], run.deps)).toBe(0);
    expect(run.mutatingCalls).toEqual([]);
    if (lease !== undefined) expect(existsSync(join(leaseDir, 'check-young.lease'))).toBe(true);
    return run.out;
  };
  for (const at of [1 + 1 / 60, 3 + 1 / 60, 100]) {
    expect(await listedWith(NOW, at)).toEqual([]);
  }
  const stale = new Date(NOW.getTime() - LEASE_MS - 1);
  for (const lease of [stale, undefined]) {
    expect(await listedWith(lease, 3 - 1 / 60)).toEqual([]);
    expect(await listedWith(lease, 3 + 1 / 60)).toEqual(['would delete check-young']);
  }
});

test('a lease is live until exactly LEASE_MS after its last refresh, and only for its branch', () => {
  const old = [{ id: 'br-old', name: 'check-old', created_at: hoursAgo(4) }];
  const refreshed = (ms: number, branch = 'check-old') => [
    { branch, refreshed_at: new Date(NOW.getTime() - LEASE_MS + ms).toISOString() },
  ];
  expect(branchesToDrop(old, undefined, NOW, refreshed(0))).toEqual([]);
  expect(branchesToDrop(old, undefined, NOW, refreshed(-1))).toEqual(old);
  expect(branchesToDrop(old, undefined, NOW, refreshed(0, 'check-new'))).toEqual(old);
  const named = [{ ...refreshed(-1)[0], run: RUN }];
  expect(branchesToDrop(old, undefined, NOW, named, NOW, new Set([RUN]))).toEqual([]);
  expect(branchesToDrop(old, undefined, NOW, named, NOW, new Set())).toEqual(old);
});

test('--help states the lease rule', async () => {
  const run = recordingDeps({ repoRoot: repo() });
  expect(await main(['--help'], run.deps)).toBe(0);
  const usage = run.out.join('\n');
  expect(usage).toContain('unless the run or checkout that owns it still uses it');
  expect(usage).toContain(`Ownership is a lease in ${defaultLeaseDir()}:`);
  expect(usage).toContain('naming the Archon run it runs in (WORKFLOW_ID) when there is one');
  expect(usage).toContain('while the run its lease names is pending, running or paused');
  expect(usage).toContain('drop asks Archon, read-only');
  expect(usage).toContain('`serve` while it runs refresh it');
  expect(usage).toContain('only age is judged at <time>: a lease and its run are judged now');
  expect(usage).toContain('or whose run is still running now, is not listed at any <time>');
  expect(usage).toContain('a young check-* branch it created that has no live lease');
  const lease = LEASE_MS === 3_600_000 ? 'an hour' : `${LEASE_MS / 3_600_000} hours`;
  const stale = `${STALE_MS / 3_600_000} hours`;
  expect(usage).toContain(`older than ${stale} unless`);
  expect(usage).toContain(`refreshed less than ${lease} ago`);
  expect(usage).toContain(`once it is over ${stale} old at <time>`);
  expect(usage).toContain(`created_at + ${STALE_MS / 3_600_000}h + 1m`);
});
