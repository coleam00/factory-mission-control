import { expect, test } from 'bun:test';
import { askArchon, runStatusFrom } from './archon-run';

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
