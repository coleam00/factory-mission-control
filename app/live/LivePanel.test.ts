import { afterEach, expect, jest, mock, spyOn, test } from 'bun:test';
import { type LiveQueryState, QueryRefreshController } from '@neon/realtime/client';
import * as rewind from '../lib/rewind';
import {
  backOffSeals,
  newSealBackoff,
  panelSealer,
  panelState,
  RENEW_EARLY_MS,
  recovering,
  renewSeal,
  SEAL_RETRY_CEILING_MS,
  SEAL_RETRY_FIRST_MS,
  SEAL_TIMEOUT_MS,
  seal,
  tabSealing,
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

test('a seal request nobody answers fails when the timeout fires, so it cannot hold the tab', async () => {
  const timeout = new AbortController();
  const timer = spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal);
  spyOn(globalThis, 'fetch').mockImplementation(
    ((_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('timed out')));
      })) as typeof fetch,
  );
  const settled = seal('home-map', '{}', null).then(
    () => 'sealed',
    (error: Error) => error.message,
  );
  expect(timer).toHaveBeenCalledWith(SEAL_TIMEOUT_MS);
  expect(await Promise.race([settled, Bun.sleep(50).then(() => 'pending')])).toBe('pending');
  timeout.abort();
  expect(await settled).toBe('timed out');
});

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
  const sent: number[] = [];
  const outcomes: string[] = [];
  const request = onClock(sent, answer, signal);
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

let clock = 0;

/** A `backOffSeals` on the test clock, logging when each request is sent into `sent`. */
function onClock(
  sent: number[],
  answer: (at: number) => { expiresAt: number } | 'fail',
  signal = new AbortController().signal,
  backoff = newSealBackoff(),
) {
  clock = 0;
  return backOffSeals(
    async () => {
      sent.push(clock);
      const answered = answer(clock);
      if (answered === 'fail') throw new Error('sealing status-strip answered 503');
      return { ...sealed, ...answered };
    },
    signal,
    {
      backoff,
      now: () => clock,
      wait: async (ms) => {
        clock += ms;
      },
    },
  );
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

test('first seals on one key, each answered with a full lifetime, owe no wait', async () => {
  const backoff = newSealBackoff();
  const sent: number[] = [];
  for (let i = 0; i < 6; i++) {
    const request = onClock(sent, (at) => ({ expiresAt: at + 60_000 }), undefined, backoff);
    clock = i * 5_000;
    await request();
  }
  expect(sent).toEqual([0, 5_000, 10_000, 15_000, 20_000, 25_000]);
  expect(backoff.delay).toBe(0);
});

test('a seal too close to expiry to wait before renewing is handed on, and the next waits', async () => {
  const { sent, outcomes } = await backOff(4, (at) => ({ expiresAt: at + 5_000 }));
  expect(outcomes).toEqual(Array(4).fill('sealed'));
  expect(sent).toEqual([0, 1_000, 3_000, 7_000]);
});

test('once the endpoint answers again, a full seal comes one wait later, and the wait holds until live', async () => {
  const sent: number[] = [];
  const backoff = newSealBackoff();
  const request = onClock(
    sent,
    (at) => (at < 10_000 ? 'fail' : { expiresAt: at + 60_000 }),
    undefined,
    backoff,
  );
  const outcomes: string[] = [];
  for (let i = 0; i < 6; i++) {
    outcomes.push(
      await request().then(
        () => 'sealed',
        () => 'thrown',
      ),
    );
  }
  expect(outcomes).toEqual(['thrown', 'thrown', 'thrown', 'thrown', 'sealed', 'sealed']);
  // A full seal alone is not recovery: the subscription can still refuse it.
  expect(sent).toEqual([0, 1_000, 3_000, 7_000, 15_000, 31_000]);
  // Live on it: the next seal owes no wait.
  backoff.delay = 0;
  await request();
  expect(sent.at(-1)).toBe(31_000);
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

test('a panel asking through a new wrapper, its effect re-run or remounted, still owes the wait', async () => {
  const sent: number[] = [];
  const backoff = newSealBackoff();
  const first = onClock(sent, () => 'fail', undefined, backoff);
  await first().catch(() => {});
  const again = backOffSeals(
    async () => {
      sent.push(clock);
      throw new Error('sealing status-strip answered 503');
    },
    new AbortController().signal,
    {
      backoff,
      now: () => clock,
      wait: async (ms) => {
        clock += ms;
      },
    },
  );
  for (let i = 0; i < 3; i++) await again().catch(() => {});
  expect(sent).toEqual([0, 1_000, 3_000, 7_000]);
});

test('seal requests made at once are sent one at a time, each a wait after the last answer', async () => {
  const sent: number[] = [];
  const request = onClock(sent, () => 'fail');
  await Promise.allSettled([request(), request(), request()]);
  expect(sent).toEqual([0, 1_000, 3_000]);
});

/**
 * A live seal renewed by `@neon/realtime`'s own controller while the endpoint replays an expired
 * seal, its refresh callback set again every 100 ms the way the React store does when its effect
 * re-runs (each time rescheduling the refresh for now). Returns when each request was sent, in
 * ms from when the live seal was due to renew.
 */
async function renewWhileStale(seconds: number): Promise<number[]> {
  jest.useFakeTimers();
  try {
    const start = Date.now();
    const renewAt = start + 60_000 - RENEW_EARLY_MS;
    const header = Buffer.from('{"alg":"dir","enc":"A256GCM","v":1}').toString('base64url');
    const live = {
      ...sealed,
      capability: `${header}..iv.ciphertext.tag`,
      expiresAt: start + 60_000,
    };
    const sent: number[] = [];
    const refreshQuery = backOffSeals(async () => {
      sent.push(Date.now() - renewAt);
      return { ...live, expiresAt: start - 60_000 };
    }, new AbortController().signal);
    const controller = new QueryRefreshController({
      query: live,
      refreshQuery,
      renewSubscription: async () => {},
      onRefreshExhausted: () => {},
    });
    controller.start();
    while (Date.now() < renewAt + seconds * 1_000) {
      jest.advanceTimersByTime(100);
      for (let i = 0; i < 10; i++) await Promise.resolve();
      controller.setRefreshCallback(refreshQuery);
    }
    controller.stop();
    return sent;
  } finally {
    jest.useRealTimers();
  }
}

test('a live panel renewing against a replayed expired seal backs off, however often rescheduled', async () => {
  const sent = await renewWhileStale(30);
  // The tight loop sent ~11,000 requests per panel in 30 s; the acceptance limit is 30.
  expect(sent.length).toBeLessThanOrEqual(30);
  expect(sent).toEqual([0, 1_000, 3_000, 7_000, 15_000]);
});

/**
 * A panel whose subscription refuses every renewal (its connection failed for good), renewed by
 * `@neon/realtime`'s own controller, which asks again 1 s after each refusal, while the endpoint
 * seals: it fails `failures` times, then answers full seals. Returns when each request was sent,
 * in ms from when the live seal was due to renew.
 */
async function renewRefused(seconds: number, failures: number): Promise<number[]> {
  jest.useFakeTimers();
  try {
    const start = Date.now();
    const renewAt = start + 50_000;
    const header = Buffer.from('{"alg":"dir","enc":"A256GCM","v":1}').toString('base64url');
    const live = {
      ...sealed,
      capability: `${header}..iv.ciphertext.tag`,
      expiresAt: start + 60_000,
    };
    const sent: number[] = [];
    const refreshQuery = backOffSeals(async () => {
      sent.push(Date.now() - renewAt);
      if (sent.length <= failures) throw new Error('sealing one-lap answered 503');
      return { ...live, expiresAt: Date.now() + 60_000 };
    }, new AbortController().signal);
    const controller = new QueryRefreshController({
      query: live,
      refreshQuery,
      renewSubscription: async () => {
        throw new Error('Realtime connection cannot recover');
      },
      onRefreshExhausted: () => {},
    });
    controller.start();
    while (Date.now() < renewAt + seconds * 1_000) {
      jest.advanceTimersByTime(100);
      for (let i = 0; i < 10; i++) await Promise.resolve();
    }
    controller.stop();
    return sent;
  } finally {
    jest.useRealTimers();
  }
}

test('a seal its subscription refuses does not reset the wait, so the panel never asks once a second', async () => {
  const sent = await renewRefused(60, 3);
  // Before #274 every full seal reset the wait: after the outage, one request a second for good.
  expect(sent).toEqual([0, 1_000, 3_000, 7_000, 15_000, 31_000, 47_000]);
  for (let i = 0; i + 1 < sent.length; i++) {
    expect(sent.filter((at) => at >= sent[i] && at < sent[i] + 10_000).length).toBeLessThanOrEqual(
      5,
    );
  }
});

/**
 * A page of `panels` live panels sealed together, each renewed by `@neon/realtime`'s controller,
 * while the endpoint fails for `outage` seconds from when they were due to renew, then seals again.
 * Returns when each request was sent, in ms from then, and how many panels got a seal after it.
 */
async function pageThroughOutage(panels: number, outage: number, seconds: number, latency = 0) {
  jest.useFakeTimers();
  try {
    const start = Date.now();
    const renewAt = start + 50_000;
    const header = Buffer.from('{"alg":"dir","enc":"A256GCM","v":1}').toString('base64url');
    const live = {
      ...sealed,
      capability: `${header}..iv.ciphertext.tag`,
      expiresAt: start + 60_000,
    };
    const sent: number[] = [];
    const renewed = new Set<number>();
    Object.assign(tabSealing, newSealBackoff());
    const controllers = Array.from({ length: panels }, (_, panel) => {
      // As LivePanel builds and renews its seals, in the tab's real sealing.
      const request = panelSealer(
        async () => {
          sent.push(Date.now() - renewAt);
          if (latency > 0) await new Promise((resolve) => setTimeout(resolve, latency));
          if (Date.now() < renewAt + outage * 1_000) throw new Error('sealing answered 503');
          return { ...live, expiresAt: Date.now() + 60_000 };
        },
        new AbortController().signal,
        newSealBackoff(),
      );
      const refreshQuery = () => renewSeal(request);
      return new QueryRefreshController({
        query: live,
        refreshQuery,
        renewSubscription: async () => {
          renewed.add(panel);
        },
        onRefreshExhausted: () => {},
      });
    });
    for (const controller of controllers) controller.start();
    while (Date.now() < renewAt + seconds * 1_000) {
      jest.advanceTimersByTime(100);
      for (let i = 0; i < 10; i++) await Promise.resolve();
    }
    for (const controller of controllers) controller.stop();
    return { sent, renewed: renewed.size };
  } finally {
    jest.useRealTimers();
  }
}

test('a page of panels in a sealing outage asks no more than 5 times in any 10 s, and every panel recovers (#274)', async () => {
  const { sent, renewed } = await pageThroughOutage(6, 90, 120);
  const during = sent.filter((at) => at < 90_000);
  for (const at of during) {
    expect(during.filter((other) => other >= at && other < at + 10_000).length).toBeLessThanOrEqual(
      5,
    );
  }
  // The waits between the tab's requests grow to the ceiling instead of staying near a second.
  const gaps = during.slice(1).map((at, i) => at - during[i]);
  expect(gaps.slice(0, 4)).toEqual([1_000, 2_000, 4_000, 8_000]);
  expect(gaps.slice(4).every((gap) => gap === 16_000)).toBe(true);
  // Sealing is back at 90 s: every panel has its seal within 30 s.
  expect(renewed).toBe(6);
  expect(sent.filter((at) => at >= 90_000 && at < 120_000).length).toBeGreaterThanOrEqual(6);
});
