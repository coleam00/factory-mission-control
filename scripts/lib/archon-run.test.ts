import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Env } from '../../server/check-env';
import { ACTIVE, askArchon, ENDED, runStatusFrom } from './archon-run';

test.each(['pending', 'running', 'paused'])('a %s run is active', (status) => {
  expect(runStatusFrom(0, JSON.stringify({ status }))).toEqual({ state: 'active' });
});

test.each(['completed', 'failed', 'cancelled'])('a %s run has ended', (status) => {
  expect(runStatusFrom(0, JSON.stringify({ status }))).toEqual({ state: 'ended' });
});

test('a run Archon has no record of has ended', () => {
  expect(runStatusFrom(1, '{"ok":false,"error":"not_found"}')).toEqual({ state: 'ended' });
});

test.each([
  [1, '{"ok":false,"error":"invalid_id"}', 'invalid_id'],
  [1, '', 'exit 1, not JSON'],
  [0, 'not json', 'exit 0, not JSON'],
  [0, '{"status":"archived"}', 'status archived'],
  [0, '{}', 'status undefined'],
  [2, '{}', 'exit 2'],
])('exit %d with %j is unknown', (code, stdout, reason) => {
  expect(runStatusFrom(code, stdout)).toEqual({ state: 'unknown', reason });
});

test.each([undefined, '', 'archon', '[]', '[1]'])(
  'asking with ARCHON_CLI_COMMAND %j is unknown without spawning',
  async (command) => {
    const status = await askArchon(
      command === undefined ? {} : { ARCHON_CLI_COMMAND: command },
      '.',
      'run-1',
    );
    expect(status).toEqual({ state: 'unknown', reason: 'ARCHON_CLI_COMMAND is not set' });
  },
);

test('ACTIVE and ENDED are the sets factory/consumer.py classifies by', () => {
  const source = readFileSync(join(import.meta.dir, '../../factory/consumer.py'), 'utf-8');
  const setOf = (name: string) =>
    new Set(
      [
        ...(source.match(new RegExp(`^${name} = {([^}]*)}`, 'm'))?.[1] ?? '').matchAll(/"(\w+)"/g),
      ].map((match) => match[1]),
    );
  expect(ACTIVE).toEqual(setOf('ACTIVE'));
  expect(ENDED).toEqual(setOf('ENDED'));
  expect(ACTIVE.size).toBeGreaterThan(0);
});

describe('askArchon spawns the Archon CLI', () => {
  const scratch: string[] = [];
  afterEach(() => {
    for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function fakeArchon(reply: string, exitCode: number): Env {
    const dir = mkdtempSync(join(tmpdir(), 'mc-archon-run-'));
    scratch.push(dir);
    const script = join(dir, 'archon.js');
    writeFileSync(
      script,
      `const ok = process.argv.slice(2).join(' ') === 'workflow get run-1 --json';
       if (ok) console.log(${JSON.stringify(reply)}); process.exit(ok ? ${exitCode} : 9);`,
    );
    return { ARCHON_CLI_COMMAND: JSON.stringify([process.execPath, script]) };
  }

  test('a running run reads as active, asked with `workflow get <run> --json`', async () => {
    const env = fakeArchon('{"status":"running"}', 0);
    expect(await askArchon(env, '.', 'run-1')).toEqual({ state: 'active' });
  });

  test('a run Archon does not know reads as ended', async () => {
    const env = fakeArchon('{"ok":false,"error":"not_found"}', 1);
    expect(await askArchon(env, '.', 'run-1')).toEqual({ state: 'ended' });
  });

  test('another run id is not the one asked about', async () => {
    const env = fakeArchon('{"status":"running"}', 0);
    expect((await askArchon(env, '.', 'run-2')).state).toBe('unknown');
  });
});
