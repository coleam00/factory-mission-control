import { expect, test } from 'bun:test';
import type { Live } from './LiveProvider';
import { shareLive } from './LiveProvider';
import {
  type FetchRows,
  type LocalSealed,
  type PollDeps,
  type PolledState,
  reviveRows,
  startPolling,
} from './poll';

const sealed: LocalSealed = { local: { query: 'board', params: ['mission-control'] } };

/** Timers that fire only when the test says, and a page whose visibility the test sets. */
function harness(answers: (() => Promise<{ rows: Record<string, unknown>[] }>)[]) {
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let next = 0;
  let hidden = false;
  let listener: (() => void) | undefined;
  const asked: LocalSealed[] = [];
  const fetchRows: FetchRows = (s) => {
    asked.push(s);
    const answer = answers.shift();
    if (!answer) throw new Error('no more answers');
    return answer();
  };
  const deps: PollDeps = {
    fetchRows,
    intervalMs: 3_000,
    isHidden: () => hidden,
    onVisibility: (l) => {
      listener = l;
      return () => {
        listener = undefined;
      };
    },
    setTimer: (fn, ms) => {
      timers.set(++next, { fn, ms });
      return next;
    },
    clearTimer: (t) => timers.delete(t as number),
  };
  const published: PolledState<unknown>[] = [];
  const fire = () => {
    const entries = [...timers.entries()];
    timers.clear();
    for (const [, t] of entries) t.fn();
  };
  return {
    deps,
    published,
    asked,
    timers,
    fire,
    setHidden(h: boolean) {
      hidden = h;
      listener?.();
    },
    get listening() {
      return listener !== undefined;
    },
  };
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

test('polls at once, then every interval after each answer, publishing live rows', async () => {
  const h = harness([async () => ({ rows: [{ n: 1 }] }), async () => ({ rows: [{ n: 2 }] })]);
  const stop = startPolling(sealed, (s) => h.published.push(s), h.deps);
  expect(h.asked).toEqual([sealed]);
  await flush();
  expect(h.published).toEqual([{ status: 'live', data: [{ n: 1 }], error: undefined }]);
  expect([...h.timers.values()].map((t) => t.ms)).toEqual([3_000]);
  h.fire();
  await flush();
  expect(h.published.at(-1)).toEqual({ status: 'live', data: [{ n: 2 }], error: undefined });
  stop();
  expect(h.timers.size).toBe(0);
  expect(h.listening).toBe(false);
});

test('a failed poll is error with the last rows kept, and the next answer is live again', async () => {
  const boom = new Error('502');
  const h = harness([
    async () => ({ rows: [{ n: 1 }] }),
    async () => {
      throw boom;
    },
    async () => ({ rows: [{ n: 3 }] }),
  ]);
  const stop = startPolling(sealed, (s) => h.published.push(s), h.deps);
  await flush();
  h.fire();
  await flush();
  expect(h.published.at(-1)).toEqual({ status: 'error', data: [{ n: 1 }], error: boom });
  h.fire();
  await flush();
  expect(h.published.at(-1)).toEqual({ status: 'live', data: [{ n: 3 }], error: undefined });
  stop();
});

test('no poll while the page is hidden; showing it polls at once', async () => {
  const h = harness([async () => ({ rows: [] }), async () => ({ rows: [{ n: 9 }] })]);
  const stop = startPolling(sealed, (s) => h.published.push(s), h.deps);
  await flush();
  expect(h.timers.size).toBe(1);
  h.setHidden(true);
  expect(h.timers.size).toBe(0);
  h.setHidden(false);
  expect(h.asked.length).toBe(2);
  await flush();
  expect(h.published.at(-1)?.data).toEqual([{ n: 9 }]);
  stop();
});

test('stopping while a poll is in flight publishes nothing more', async () => {
  let answer: (v: { rows: Record<string, unknown>[] }) => void = () => {};
  const h = harness([() => new Promise((r) => (answer = r))]);
  const stop = startPolling(sealed, (s) => h.published.push(s), h.deps);
  stop();
  answer({ rows: [{ n: 1 }] });
  await flush();
  expect(h.published).toEqual([]);
  expect(h.timers.size).toBe(0);
});

test('timestamp and date columns become Dates', () => {
  const [row] = reviveRows<{ at: Date; day: Date; n: number }>({
    rows: [{ at: '2026-11-16T10:00:00.000Z', day: '2026-11-16', n: 1 }],
    timestamps: ['at'],
    dates: ['day'],
  });
  expect(row?.at.toISOString()).toBe('2026-11-16T10:00:00.000Z');
  expect(row?.day.getFullYear()).toBe(2026);
  expect(row?.day.getMonth()).toBe(10);
  expect(row?.day.getDate()).toBe(16);
  expect(row?.n).toBe(1);
});

test('a local boot is ready at once with no Realtime client', () => {
  const published: Live[] = [];
  const stop = shareLive(
    {
      url: '',
      home: '',
      factories: ['mission-control'],
      rewind: null,
      mode: 'local',
      protocol: '',
    },
    (l) => published.push(l),
    () => {
      throw new Error('local mode must not connect');
    },
  );
  expect(published).toEqual([
    {
      status: 'ready',
      mode: 'local',
      factories: ['mission-control'],
      rewind: null,
      offline: false,
      homeOffline: false,
    },
  ]);
  stop();
});
