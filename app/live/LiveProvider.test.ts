import { afterEach, expect, jest, spyOn, test } from 'bun:test';
import type { RealtimeClient } from '@neon/realtime/client';
import { LIVE_STABLE_MS } from './LivePanel';
import {
  type Connect,
  connect,
  type Live,
  OFFLINE_AFTER_MS,
  REPLACE_CEILING_MS,
  REPLACE_FIRST_MS,
  REPLACE_STABLE_MS,
  shareLive,
} from './LiveProvider';

interface Fake {
  url: string;
  end: () => void;
  down: () => void;
  up: () => void;
  ended: boolean;
  closed: boolean;
}

function harness(rewind: string | null) {
  const opened: Fake[] = [];
  const published: Live[] = [];
  const open: Connect = (url, _transport, report) => {
    const fake: Fake = {
      url,
      ended: false,
      closed: false,
      end: () => {
        fake.ended = true;
        report('ended');
      },
      down: () => report('down'),
      up: () => report('up'),
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
    (live) => published.push(live),
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
  return { opened, published, endAndTime, stop };
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

/** The last `Live` published, which is a `ready` one once the clients are open. */
function last(published: Live[]) {
  const live = published.at(-1);
  if (live?.status !== 'ready') throw new Error('nothing ready was published');
  return live;
}

test('a client whose connection stays down OFFLINE_AFTER_MS is published offline, and online once it connects', () => {
  jest.useFakeTimers();
  const h = harness(null);
  h.opened[0]?.down();
  jest.advanceTimersByTime(OFFLINE_AFTER_MS - 1);
  expect(last(h.published).offline).toBe(false);
  jest.advanceTimersByTime(1);
  expect(last(h.published)).toMatchObject({ offline: true, homeOffline: true });
  h.opened[0]?.up();
  expect(last(h.published)).toMatchObject({ offline: false, homeOffline: false });
  h.stop();
});

test('a brief reconnect after a healthy stretch never publishes offline', () => {
  jest.useFakeTimers();
  const h = harness(null);
  h.opened[0]?.up();
  jest.advanceTimersByTime(REPLACE_STABLE_MS);
  h.opened[0]?.down();
  jest.advanceTimersByTime(OFFLINE_AFTER_MS - 1_000);
  h.opened[0]?.up();
  jest.advanceTimersByTime(2 * OFFLINE_AFTER_MS);
  expect(h.published.filter((live) => live.status === 'ready' && live.offline)).toEqual([]);
  h.stop();
});

test('while rewound, only the client that is down is offline', () => {
  jest.useFakeTimers();
  const h = harness('rewind-x');
  h.opened.find((f) => f.url === 'wss://home')?.down();
  jest.advanceTimersByTime(OFFLINE_AFTER_MS);
  expect(last(h.published)).toMatchObject({ offline: false, homeOffline: true });
  h.stop();
});

test('a replaced client leaves no offline timer, and a closed provider publishes nothing', () => {
  jest.useFakeTimers();
  spyOn(console, 'warn').mockImplementation(() => {});
  const replaced = harness(null);
  replaced.opened[0]?.down();
  replaced.endAndTime('wss://main');
  jest.advanceTimersByTime(2 * OFFLINE_AFTER_MS);
  expect(last(replaced.published).offline).toBe(false);
  replaced.stop();

  const closed = harness(null);
  closed.opened[0]?.down();
  closed.stop();
  const before = closed.published.length;
  jest.advanceTimersByTime(2 * OFFLINE_AFTER_MS);
  expect(closed.published.length).toBe(before);
});

/** A socket the scripted server refuses (errors, then closes) while `server.refuse`, else greets. */
const server = { refuse: true, sockets: 0 };
class Sock {
  readyState = 0;
  private listeners = new Map<string, ((e: { data: unknown }) => void)[]>();
  constructor() {
    server.sockets++;
    const refused = server.refuse;
    setTimeout(() => {
      if (refused) {
        this.readyState = 3;
        this.emit('error');
        this.emit('close');
      } else {
        this.readyState = 1;
        this.emit('open');
        this.emit('message', JSON.stringify({ type: 'ready' }));
      }
    }, 5);
  }
  addEventListener(type: string, listener: (e: { data: unknown }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  emit(type: string, data?: unknown) {
    for (const listener of this.listeners.get(type) ?? []) listener({ data });
  }
  send() {}
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit('close');
  }
}

test('the real client, refused on every attempt, is published offline after the wait, and online once it connects (#684)', async () => {
  jest.useFakeTimers();
  server.refuse = true;
  server.sockets = 0;
  const published: Live[] = [];
  const stop = shareLive(
    { url: 'wss://refused', home: 'wss://refused', factories: [], rewind: null, protocol: 'p' },
    (live) => published.push(live),
    (url, _transport, report) => connect(url, (() => new Sock()) as never, report),
  );
  const live = last(published);
  const header = Buffer.from(JSON.stringify({ alg: 'dir', enc: 'A256GCM', v: 1 })).toString(
    'base64url',
  );
  live.client.subscribe({
    capability: `${header}..nonce.a.tag`,
    queryFingerprint: 'a'.repeat(64),
    expiresAt: Date.now() + 600_000,
  } as never);
  const advance = async (ms: number) => {
    jest.advanceTimersByTime(ms);
    await Promise.resolve();
  };
  await advance(OFFLINE_AFTER_MS - 500);
  expect(last(published).offline).toBe(false);
  expect(server.sockets).toBeGreaterThan(1);
  await advance(1_000);
  expect(last(published).offline).toBe(true);
  server.refuse = false;
  for (let ms = 0; last(published).offline && ms < 60_000; ms += 100) await advance(100);
  expect(last(published).offline).toBe(false);
  stop();
});

test('the stable period matches the panels', () => {
  expect(REPLACE_STABLE_MS).toBe(LIVE_STABLE_MS);
});
