import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import type { LiveQueryState } from '@neon/realtime/client';
import * as rewind from '../lib/rewind';
import {
  backOffSeals,
  panelState,
  recovering,
  SEAL_RETRY_CEILING_MS,
  SEAL_RETRY_FIRST_MS,
  seal,
} from './LivePanel';

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

/**
 * Drives `backOffSeals` on a clock that only moves when it waits: each call is one seal request
 * the controller or the panel makes, answered by `answer` at that moment. Returns when each
 * request was sent, and what each call settled to.
 */
async function backOff(
  calls: number,
  answer: (at: number) => { expiresAt: number } | 'fail',
  signal = new AbortController().signal,
) {
  let clock = 0;
  const sent: number[] = [];
  const outcomes: string[] = [];
  const request = backOffSeals(
    async () => {
      sent.push(clock);
      const answered = answer(clock);
      if (answered === 'fail') throw new Error('sealing status-strip answered 503');
      return { ...sealed, ...answered };
    },
    signal,
    {
      now: () => clock,
      wait: async (ms) => {
        clock += ms;
      },
    },
  );
  for (let i = 0; i < calls; i++) {
    outcomes.push(
      await request().then(
        () => 'sealed',
        () => 'thrown',
      ),
    );
  }
  return { sent, outcomes };
}

test('a seal that keeps failing is asked for again after a doubling wait, up to a ceiling', async () => {
  const { sent, outcomes } = await backOff(8, () => 'fail');
  expect(outcomes).toEqual(Array(8).fill('thrown'));
  expect(sent).toEqual([0, 1_000, 3_000, 7_000, 15_000, 31_000, 47_000, 63_000]);
  expect(SEAL_RETRY_FIRST_MS).toBe(1_000);
  expect(SEAL_RETRY_CEILING_MS).toBe(16_000);
});

test('an expired seal is never handed on, and is asked for again only after a wait', async () => {
  const { sent, outcomes } = await backOff(6, (at) => ({ expiresAt: at - 60_000 }));
  expect(outcomes).toEqual(Array(6).fill('thrown'));
  expect(sent).toEqual([0, 1_000, 3_000, 7_000, 15_000, 31_000]);
  // A stale seal replayed for 30 s: the tight loop sent ~37k requests; this sends 5.
  expect(sent.filter((at) => at < 30_000)).toHaveLength(5);
});

test('a seal too close to expiry to wait before renewing is handed on, and the next waits', async () => {
  const { sent, outcomes } = await backOff(4, (at) => ({ expiresAt: at + 5_000 }));
  expect(outcomes).toEqual(Array(4).fill('sealed'));
  expect(sent).toEqual([0, 1_000, 3_000, 7_000]);
});

test('once the endpoint answers again, a full seal comes one wait later and resets the wait', async () => {
  const { sent, outcomes } = await backOff(6, (at) =>
    at < 10_000 ? 'fail' : { expiresAt: at + 60_000 },
  );
  expect(outcomes).toEqual(['thrown', 'thrown', 'thrown', 'thrown', 'sealed', 'sealed']);
  expect(sent).toEqual([0, 1_000, 3_000, 7_000, 15_000, 15_000]);
});

test('a panel that stopped asking sends no more seal requests', async () => {
  const stopped = new AbortController();
  let calls = 0;
  const { sent, outcomes } = await backOff(
    3,
    () => {
      if (++calls === 1) stopped.abort();
      return 'fail';
    },
    stopped.signal,
  );
  expect(sent).toEqual([0]);
  expect(outcomes).toEqual(['thrown', 'thrown', 'thrown']);
});
