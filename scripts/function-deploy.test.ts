import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { FUNCTION_ENV } from '../function/env';
import type { Env } from '../server/check-env';
import { main } from './function-deploy';
import type { NeonctlResult } from './lib/cli';
import { FUNCTION_URL, POOLED_URL, PROJECT, recordingDeps, scratchRepo } from './lib/test-deps';

const BRANCHES = [
  { id: 'br-check', name: 'check-abc', created_at: '' },
  { id: 'br-main', name: 'main', created_at: '' },
  { id: 'br-fixture', name: 'fixture', created_at: '' },
];
const SECRETS = {
  [FUNCTION_ENV.webhookSecret]: 'whsec-test',
  [FUNCTION_ENV.githubToken]: 'ghp-test',
};

function run(
  argv: string[],
  options: { env?: Env; neonctl?: (args: string[]) => NeonctlResult } = {},
) {
  const repoRoot = scratchRepo();
  const recorder = recordingDeps({
    repoRoot,
    branches: BRANCHES,
    env: options.env ?? SECRETS,
    neonctl: options.neonctl,
  });
  return { repoRoot, recorder, exit: main(argv, recorder.deps) };
}

const deployArgs = (repoRoot: string, branchId: string) => [
  'functions',
  'deploy',
  'mcwebhook',
  '--src',
  join(repoRoot, 'function', 'index.ts'),
  '--runtime',
  'nodejs24',
  '--project-id',
  PROJECT,
  '--branch',
  branchId,
  '--env',
  `${FUNCTION_ENV.databaseUrl}=${POOLED_URL}`,
  '--env',
  `${FUNCTION_ENV.webhookSecret}=whsec-test`,
  '--env',
  `${FUNCTION_ENV.githubToken}=ghp-test`,
  '--output',
  'json',
];

const leaks = (lines: string[]) =>
  lines.filter((line) => ['whsec-test', 'ghp-test', 'pooled-pw'].some((s) => line.includes(s)));

test('deploys to a check branch with its pooled URL and prints only the URL', async () => {
  const { repoRoot, recorder, exit } = run(['--branch', 'check-abc']);
  expect(await exit).toBe(0);
  expect(recorder.neonctlCalls).toEqual([deployArgs(repoRoot, 'br-check')]);
  expect(recorder.neonCalls).toEqual(['listBranches', 'pooledConnectionUri br-check']);
  expect(recorder.out).toEqual([FUNCTION_URL]);
  expect(recorder.err).toEqual([]);
});

test('--branch main deploys to main', async () => {
  const { repoRoot, recorder, exit } = run(['--branch', 'main']);
  expect(await exit).toBe(0);
  expect(recorder.neonctlCalls).toEqual([deployArgs(repoRoot, 'br-main')]);
});

test.each(['fixture', 'Cole', 'check_x'])('refuses %s before any Neon call', async (name) => {
  const { recorder, exit } = run(['--branch', name]);
  expect(await exit).toBe(1);
  expect(recorder.err.join('\n')).toContain(`refusing branch '${name}'`);
  expect(recorder.neonCalls).toEqual([]);
  expect(recorder.neonctlCalls).toEqual([]);
});

test('without --branch it prints usage and exits 2', async () => {
  const { recorder, exit } = run([]);
  expect(await exit).toBe(2);
  expect(recorder.err.join('\n')).toContain('usage: bun run function:deploy');
  expect(recorder.neonCalls).toEqual([]);
});

test('without the webhook secret it deploys nothing', async () => {
  const env = { [FUNCTION_ENV.githubToken]: 'ghp-test' };
  const { recorder, exit } = run(['--branch', 'check-abc'], { env });
  expect(await exit).toBe(1);
  expect(recorder.err.join('\n')).toContain(`${FUNCTION_ENV.webhookSecret} must be set`);
  expect(recorder.neonCalls).not.toContain('pooledConnectionUri br-check');
  expect(recorder.neonctlCalls).toEqual([]);
});

test('an unknown check branch deploys nothing', async () => {
  const { recorder, exit } = run(['--branch', 'check-nope']);
  expect(await exit).toBe(1);
  expect(recorder.err).toEqual(['no branch named check-nope']);
  expect(recorder.neonctlCalls).toEqual([]);
});

test('a failed deploy reports neonctl stderr with every secret redacted', async () => {
  const { recorder, exit } = run(['--branch', 'check-abc'], {
    neonctl: () => ({
      code: 1,
      stdout: '',
      stderr: `bad env MC_DATABASE_URL=${POOLED_URL} GITHUB_WEBHOOK_SECRET=whsec-test pw=pooled-pw\n`,
    }),
  });
  expect(await exit).toBe(1);
  expect(recorder.err.join('\n')).toContain('neonctl functions deploy failed: bad env');
  expect(recorder.err.join('\n')).toContain('***');
  expect(leaks([...recorder.out, ...recorder.err])).toEqual([]);
});

test('a deploy whose report has no invocation_url fails without echoing it', async () => {
  const { recorder, exit } = run(['--branch', 'check-abc'], {
    neonctl: () => ({ code: 0, stdout: '{"env":"GITHUB_TOKEN=ghp-test"}', stderr: '' }),
  });
  expect(await exit).toBe(1);
  expect(recorder.err).toEqual(['neonctl reported no invocation_url for mcwebhook']);
  expect(recorder.out).toEqual([]);
});

test('--delete removes mcwebhook from the branch', async () => {
  const { recorder, exit } = run(['--branch', 'check-abc', '--delete']);
  expect(await exit).toBe(0);
  expect(recorder.neonctlCalls).toEqual([
    ['functions', 'delete', 'mcwebhook', '--project-id', PROJECT, '--branch', 'br-check'],
  ]);
  expect(recorder.out).toEqual(['deleted mcwebhook from check-abc']);
});
