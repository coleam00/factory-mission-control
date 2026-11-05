import { afterEach, expect, jest, spyOn, test } from 'bun:test';
import type { RealtimeClient } from '@neon/realtime/client';
import { LIVE_STABLE_MS } from './LivePanel';
import {
  type Connect,
  REPLACE_CEILING_MS,
  REPLACE_FIRST_MS,
  REPLACE_STABLE_MS,
  shareLive,
} from './LiveProvider';

interface Fake {
  url: string;
  end: () => void;
  ended: boolean;
  closed: boolean;
}

function harness(rewind: string | null) {
  const opened: Fake[] = [];
  const open: Connect = (url, _transport, ended) => {
    const fake: Fake = {
      url,
      ended: false,
      closed: false,
      end: () => {
        fake.ended = true;
        ended();
      },
    };
    opened.push(fake);
    return {
      subscribe() {},
      close() {
        fake.closed = true;
      },
    } as unknown as RealtimeClient;
  };
  const stop = shareLive(
    { url: 'wss://main', home: 'wss://home', factories: [], rewind, protocol: 'p' },
    () => {},
    open,
  );
  /** Ends the latest client on `url` and returns how long until its replacement opens. */
  const endAndTime = (url: string): number => {
    const before = opened.length;
    const latest = opened.filter((f) => f.url === url).at(-1);
    if (!latest) throw new Error(`no client on ${url}`);
    latest.end();
    let ms = 0;
    while (opened.length === before) {
      if (ms > 2 * REPLACE_CEILING_MS) throw new Error('never replaced');
      jest.advanceTimersByTime(100);
      ms += 100;
    }
    return ms;
  };
  return { opened, endAndTime, stop };
}

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

test.each([
  ['wss://main', null],
  ['wss://home', 'rewind-x'],
] as const)(
  'a client on %s that ends after a healthy stretch is replaced after REPLACE_FIRST_MS, and quick ends still back off',
  (url, rewind) => {
    jest.useFakeTimers();
    spyOn(console, 'warn').mockImplementation(() => {});
    const h = harness(rewind);
    const waits = [1, 2, 3, 4, 5, 6].map(() => h.endAndTime(url));
    expect(waits).toEqual([1000, 2000, 4000, 8000, 16000, 16000]);
    jest.advanceTimersByTime(REPLACE_STABLE_MS);
    expect(h.endAndTime(url)).toBe(REPLACE_FIRST_MS);
    expect(h.endAndTime(url)).toBe(2 * REPLACE_FIRST_MS);
    h.stop();
    expect(h.opened.filter((f) => f.ended && f.closed)).toEqual([]);
  },
);

test('the stable period matches the panels', () => {
  expect(REPLACE_STABLE_MS).toBe(LIVE_STABLE_MS);
});
