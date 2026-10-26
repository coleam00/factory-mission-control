import { afterEach, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import type { Branch } from './lib/neon';
import { DATABASE_URL, hoursAgo, recordingDeps, scratchRepo } from './lib/test-deps';
import { main, rewindBranchName } from './rewind-create';

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const BRANCHES: Branch[] = [
  { id: 'br-main', name: 'main', created_at: hoursAgo(720) },
  { id: 'br-check-abc', name: 'check-abc', created_at: hoursAgo(1) },
];

const NAME = 'rewind-2026-10-24t11-00-00z';
const INSERT = 'INSERT INTO mc.rewind_branches (name, parent, at) VALUES ($1, $2, $3)';

function run(options: Partial<Parameters<typeof recordingDeps>[0]> = {}) {
  const repoRoot = scratchRepo();
  scratch.push(repoRoot);
  return recordingDeps({
    repoRoot,
    env: { MC_DATABASE_URL: DATABASE_URL },
    branches: BRANCHES,
    branchName: 'check-abc',
    ...options,
  });
}

test('a time more than 7 days back is refused before any Neon call or connection', async () => {
  const r = run();
  expect(await main(['2026-10-16T12:00:00Z'], r.deps)).not.toBe(0);
  expect(r.neonCalls).toEqual([]);
  expect(r.mutatingCalls).toEqual([]);
  expect(r.opened).toEqual([]);
  expect(r.err.join('\n')).toContain('more than 7 days back');
});

test('a time in the future is refused before any Neon call', async () => {
  const r = run();
  expect(await main(['2026-10-24T12:00:01Z'], r.deps)).not.toBe(0);
  expect(r.neonCalls).toEqual([]);
  expect(r.opened).toEqual([]);
});

test.each([
  [['not-a-time']],
  [[]],
  [['2026-10-24T11:00:00Z', '2026-10-24T10:00:00Z']],
  [['2026-10-24T11:00:00']],
])('%j is a usage error and asks nothing of Neon', async (argv) => {
  const r = run();
  expect(await main(argv, r.deps)).toBe(2);
  expect(r.neonCalls).toEqual([]);
  expect(r.err.join('\n')).toContain('usage: bun run rewind:create');
});

test('on a check branch it makes the rewind branch, then writes exactly one row there', async () => {
  const r = run();
  expect(await main(['2026-10-24T11:00:00Z', '--parent', 'check-abc'], r.deps)).toBe(0);
  expect(r.mutatingCalls).toEqual([
    `createRewindBranch ${NAME} from br-check-abc at 2026-10-24T11:00:00.000Z`,
  ]);
  expect(r.opened).toEqual([DATABASE_URL]);
  expect(r.sql).toEqual([INSERT]);
  expect(r.params).toEqual([[NAME, 'check-abc', '2026-10-24T11:00:00.000Z']]);
  const registering = r.out.findIndex((line) => line.startsWith(`registering ${NAME}`));
  expect(registering).toBeGreaterThanOrEqual(0);
  expect(r.out.indexOf(`created ${NAME}`)).toBeGreaterThan(registering);
});

test('the parent defaults to main', async () => {
  const r = run();
  expect(await main(['2026-10-24T11:00:00Z'], r.deps)).toBe(0);
  expect(r.mutatingCalls).toEqual([
    `createRewindBranch ${NAME} from br-main at 2026-10-24T11:00:00.000Z`,
  ]);
  expect(r.params).toEqual([[NAME, 'main', '2026-10-24T11:00:00.000Z']]);
});

test('when the dashboard serves main, it writes there only for the owner', async () => {
  const refused = run({ branchName: 'main' });
  expect(await main(['2026-10-24T11:00:00Z'], refused.deps)).toBe(1);
  expect(refused.mutatingCalls).toEqual([]);
  expect(refused.opened).toEqual([]);
  expect(refused.err.join('\n')).toContain('only for the owner, at a terminal');

  const owner = run({ branchName: 'main', owner: true });
  expect(await main(['2026-10-24T11:00:00Z'], owner.deps)).toBe(0);
  expect(owner.sql).toEqual([INSERT]);
});

test('a served branch that is neither check-* nor main is refused before any mutation', async () => {
  const r = run({ branchName: 'fixture', owner: true });
  expect(await main(['2026-10-24T11:00:00Z'], r.deps)).toBe(1);
  expect(r.mutatingCalls).toEqual([]);
  expect(r.opened).toEqual([]);
});

test('an unknown parent or an existing rewind of the same name is refused before any mutation', async () => {
  const unknown = run();
  expect(await main(['2026-10-24T11:00:00Z', '--parent', 'nope'], unknown.deps)).toBe(1);
  expect(unknown.err.join('\n')).toContain('no branch named nope');
  expect(unknown.mutatingCalls).toEqual([]);

  const taken = run({
    branches: [...BRANCHES, { id: 'br-r', name: NAME, created_at: hoursAgo(1) }],
  });
  expect(await main(['2026-10-24T11:00:00Z'], taken.deps)).toBe(1);
  expect(taken.err.join('\n')).toContain(`${NAME} already exists`);
  expect(taken.mutatingCalls).toEqual([]);
});

test('a failure after the branch exists deletes it again', async () => {
  const realtime = run({ throwsOn: ['getRealtime br-rewind'] });
  expect(await main(['2026-10-24T11:00:00Z'], realtime.deps)).toBe(1);
  expect(realtime.mutatingCalls.at(-1)).toBe(`deleteRewindBranch ${NAME}`);
  expect(realtime.sql).toEqual([]);

  const insert = run({
    rows: (sql) => {
      if (sql.startsWith('INSERT')) throw new Error('insert failed');
      return [];
    },
  });
  expect(await main(['2026-10-24T11:00:00Z'], insert.deps)).toBe(1);
  expect(insert.mutatingCalls.at(-1)).toBe(`deleteRewindBranch ${NAME}`);
  expect(insert.err.join('\n')).toContain('insert failed');
});

test('names the branch for the UTC moment to the second', () => {
  expect(rewindBranchName(new Date('2026-10-25T14:00:00+02:00'))).toBe(
    'rewind-2026-10-25t12-00-00z',
  );
});
