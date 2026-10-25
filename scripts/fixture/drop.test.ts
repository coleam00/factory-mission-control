import { afterEach, expect, test } from 'bun:test';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { CHECK_ENV_FILE } from '../../server/check-env';
import { hoursAgo, recordingDeps, scratchRepo } from '../lib/test-deps';
import { main } from './drop';

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
