import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHECK_ENV_FILE, type Env, formatCheckEnv, loadCheckEnv, parseCheckEnv } from './check-env';

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function repoWith(text?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'mc-check-env-'));
  scratch.push(dir);
  if (text !== undefined) writeFileSync(join(dir, CHECK_ENV_FILE), text);
  return dir;
}

test('format and parse round trip, ignoring comments and blank lines', () => {
  const values = {
    MC_CHECK_BRANCH: 'check-0a1b2c3d',
    MC_DATABASE_URL: 'postgresql://u:p@ep-x.neon.tech/db?sslmode=require&a=b',
  };
  expect(parseCheckEnv(`# written by fixture:branch\n\n${formatCheckEnv(values)}`)).toEqual(values);
});

test('loadCheckEnv fills an unset key and leaves a set key alone', () => {
  const env: Env = { MC_DATABASE_URL: 'from-launcher' };
  loadCheckEnv(repoWith('MC_DATABASE_URL=from-file\nMC_CHECK_BRANCH=check-abc\n'), env);
  expect(env).toEqual({ MC_DATABASE_URL: 'from-launcher', MC_CHECK_BRANCH: 'check-abc' });
});

test('loadCheckEnv without the file changes nothing', () => {
  const env: Env = { A: '1' };
  loadCheckEnv(repoWith(), env);
  expect(env).toEqual({ A: '1' });
});
