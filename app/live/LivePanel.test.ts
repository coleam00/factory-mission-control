import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import type { LiveQueryState } from '@neon/realtime/client';
import * as rewind from '../lib/rewind';
import { panelState, recovering, seal } from './LivePanel';

test('a panel is loading until rows arrive', () => {
  expect(panelState({ status: 'connecting', data: undefined, error: undefined })).toBe('loading');
});

test('a panel with rows is ready, including retained rows while a renewal reconnects', () => {
  expect(panelState({ status: 'live', data: [], error: undefined })).toBe('ready');
  expect(panelState({ status: 'live', data: [{ running: 2 }], error: undefined })).toBe('ready');
  expect(panelState({ status: 'connecting', data: [{ running: 2 }], error: undefined })).toBe(
    'ready',
  );
});

test('a panel whose seal expired with no replacement is in error, not ready with old rows', () => {
  expect(panelState({ status: 'stale', data: [{ running: 4 }], error: undefined })).toBe('error');
  expect(panelState({ status: 'stale', data: undefined, error: undefined })).toBe('error');
});

test('a panel whose query reports an error is in error, rows or not', () => {
  const error = { code: 'upstream_rejected', message: 'unsupported query' };
  expect(panelState({ status: 'error', data: undefined, error })).toBe('error');
  expect(panelState({ status: 'error', data: [{ running: 2 }], error })).toBe('error');
});

/** The panel's state at each step of a subscription's statuses, carrying rows the way it does. */
function walk(steps: { status: LiveQueryState['status']; data: readonly unknown[] | undefined }[]) {
  let wasRecovering = false;
  return steps.map(({ status, data }) => {
    wasRecovering = recovering(wasRecovering, status);
    return panelState({ status, data, error: undefined, recovering: wasRecovering });
  });
}

test('a panel reconnecting after its seal expired is loading, not ready with pre-outage rows', () => {
  const before = [{ running: 3 }];
  const fresh = [{ running: 4 }];
  expect(
    walk([
      { status: 'live', data: before },
      { status: 'stale', data: before },
      { status: 'connecting', data: before },
      { status: 'connecting', data: before },
      { status: 'live', data: fresh },
      { status: 'connecting', data: fresh },
    ]),
  ).toEqual(['ready', 'error', 'loading', 'loading', 'ready', 'ready']);
});

test('a panel reconnecting after an error is loading until it is live again', () => {
  const rows = [{ running: 2 }];
  expect(
    walk([
      { status: 'live', data: rows },
      { status: 'error', data: rows },
      { status: 'connecting', data: rows },
      { status: 'live', data: rows },
    ]),
  ).toEqual(['ready', 'error', 'loading', 'ready']);
});

const sealed = { capability: 'capability', queryFingerprint: 'a'.repeat(64), expiresAt: 60_000 };

/** Seals `home-map` from a page on `branch`, the server answering a seal for `answered`. */
async function sealOn(branch: string | null, answered: string | null) {
  spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ ...sealed, rewind: answered }));
  const follow = spyOn(rewind, 'followSwitch').mockImplementation(() => {});
  const settled = seal('home-map', '{"factory":"factory-a"}', branch).then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  const outcome = await Promise.race([settled, Bun.sleep(50).then(() => 'pending')]);
  return { outcome, follow };
}

afterEach(() => mock.restore());

test('a seal for the branch the page is on reaches the panel without the branch', async () => {
  const { outcome, follow } = await sealOn(null, null);
  expect(outcome).toEqual({ value: sealed });
  expect(follow).not.toHaveBeenCalled();

  const onRewind = await sealOn('rewind-x', 'rewind-x');
  expect(onRewind.outcome).toEqual({ value: sealed });
  expect(onRewind.follow).not.toHaveBeenCalled();
});

test('a page on home follows a seal for a rewind branch, and the seal never reaches it', async () => {
  const { outcome, follow } = await sealOn(null, 'rewind-x');
  expect(follow).toHaveBeenCalledTimes(1);
  expect(outcome).toBe('pending');
});

test('a page on a rewind branch follows a seal for home, and the seal never reaches it', async () => {
  const { outcome, follow } = await sealOn('rewind-x', null);
  expect(follow).toHaveBeenCalledTimes(1);
  expect(outcome).toBe('pending');
});
