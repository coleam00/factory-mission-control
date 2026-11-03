import { afterEach, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { readLeases, writeLease } from '../../server/check-lease';
import { main as branch } from '../fixture/branch';
import { main as drop } from '../fixture/drop';
import { main as seed } from '../fixture/seed';
import { main as projectionLocks } from '../projection-locks';
import { guardedDatabaseUrl, type Main } from './cli';
import { DATABASE_URL, hoursAgo, NOW, recordingDeps, scratchRepo } from './test-deps';

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function run(main: Main, argv: string[]) {
  const repoRoot = scratchRepo({ MC_CHECK_BRANCH: 'check-abc' });
  scratch.push(repoRoot);
  const recorder = recordingDeps({ repoRoot });
  const code = await main(argv, recorder.deps);
  return { ...recorder, code };
}

const SCRIPTS: Record<string, Main> = {
  'fixture:drop': drop,
  'fixture:branch': branch,
  'fixture:seed': seed,
  'projection:locks': projectionLocks,
};
const NAMES = Object.keys(SCRIPTS);

test.each([
  ['fixture:drop', ['--dry-run', '--bogus']],
  ['fixture:drop', ['--bogus', '--dry-run']],
  ['fixture:branch', ['--stale', '--bogus']],
  ['fixture:branch', ['--bogus', '--stale']],
  ...NAMES.map((name) => [name, ['--bogus']]),
] as [string, string[]][])('%s %j names --bogus as the argument it refuses', async (name, argv) => {
  const { code, err, out, neonCalls, opened } = await run(SCRIPTS[name], argv);
  expect(code).toBe(2);
  expect(err[0]?.split('\n')[0]).toBe('unexpected argument --bogus');
  expect(err.join('\n')).toContain(`usage: bun run ${name}`);
  expect(out).toEqual([]);
  expect(neonCalls).toEqual([]);
  expect(opened).toEqual([]);
});

test.each(
  NAMES.flatMap((name) => [
    [name, '--help'],
    [name, '-h'],
  ]),
)('%s %s alone prints usage and exits 0', async (name, flag) => {
  const { code, err, out, neonCalls } = await run(SCRIPTS[name], [flag]);
  expect(code).toBe(0);
  expect(out.join('\n')).toContain(`usage: bun run ${name}`);
  expect(err).toEqual([]);
  expect(neonCalls).toEqual([]);
});

async function guardedCheck(lease?: string) {
  const repoRoot = scratchRepo({ MC_DATABASE_URL: DATABASE_URL });
  scratch.push(repoRoot);
  const recorder = recordingDeps({ repoRoot, branchName: 'check-abc' });
  if (lease) writeLease(recorder.deps.leaseDir, 'check-abc', new Date(lease));
  expect(await guardedDatabaseUrl(recorder.deps, 'check')).toBe(DATABASE_URL);
  return readLeases(recorder.deps.leaseDir);
}

test("guardedDatabaseUrl refreshes the check branch's lease", async () => {
  expect(await guardedCheck(hoursAgo(2))).toEqual([
    { branch: 'check-abc', refreshed_at: NOW.toISOString() },
  ]);
});

test('guardedDatabaseUrl creates no lease where there is none', async () => {
  expect(await guardedCheck()).toEqual([]);
});
