import { expect, setSystemTime, test } from 'bun:test';
import { FACTORY_MAP } from '../../app/map/factory-map';
import {
  freePort,
  LIMITS,
  lateWrite,
  mapMismatches,
  mapWidthFailures,
  openAtWidth,
  type ShownCard,
  waitForHealth,
} from './shared';

test('freePort waits while every port in 8850-8864 is taken and takes the first one freed', async () => {
  const lines: string[] = [];
  let clock = 0;
  const deps = {
    now: () => new Date(clock),
    sleep: async (ms: number) => {
      clock += ms;
    },
    out: (line: string) => lines.push(line),
  };
  const port = await freePort(deps, { pollMs: 1000, free: (p) => p === 8857 && clock >= 3000 });
  expect(port).toBe(8857);
  expect(lines).toEqual([
    'every port in 8850-8864 is taken: waiting for one (up to 30 min)',
    'port 8857 is free',
  ]);
});

test('freePort gives up once its wait runs out', async () => {
  let clock = 0;
  const deps = {
    now: () => new Date(clock),
    sleep: async (ms: number) => {
      clock += ms;
    },
    out: () => {},
  };
  await expect(freePort(deps, { waitMs: 120_000, free: () => false })).rejects.toThrow(
    'no free port in 8850-8864 after 2 min',
  );
});

test('a missing or late write names its reading and its value', () => {
  const limit = LIMITS.insertToScreenMs;
  expect(lateWrite('the pin before the hold (pinToScreenMs)', 'the versions screen', null)).toEqual(
    [
      `the pin before the hold (pinToScreenMs) never reached the versions screen within ${limit} ms`,
    ],
  );
  expect(lateWrite('label first', 'the issues screen', undefined)).toEqual([
    `label first never reached the issues screen within ${limit} ms`,
  ]);
  expect(lateWrite('a pin', 'the versions screen', limit + 1)).toEqual([
    `a pin reached the versions screen after ${limit + 1} ms, limit ${limit}`,
  ]);
  expect(lateWrite('a pin', 'the versions screen', limit)).toEqual([]);
});

/** The map's cards in document order, each counting the laps `counts` gives it. */
const shown = (counts: Record<string, number> = {}): ShownCard[] =>
  FACTORY_MAP.cards.map((c) => ({ card: c.id, count: String(counts[c.id] ?? 0) }));

test("the map is compared card for card with factory-map.json and each card's laps with the database", () => {
  const counts = new Map([['app', 1]]);
  expect(mapMismatches(shown({ app: 1 }), counts)).toEqual([]);
  expect(mapMismatches(shown({ app: 1, build: 1 }), counts)).toEqual([
    'build shows 1 laps, the database has 0',
  ]);
  expect(mapMismatches(shown({ app: 1 }).slice(1), counts)[0]).toStartWith(
    'the map shows cards prd, ',
  );
});

test("the map's frame passes when it spans the column and fails, naming it, when narrower", () => {
  const fitted = {
    title: 14.3,
    text: 11.5,
    kind: 10.3,
    label: 10.3,
    frameWidth: 1176,
    columnWidth: 1224,
  };
  expect(mapWidthFailures(fitted)).toEqual([]);
  // The v3 shell at 1440: 216px nav, and with the Manager dock open 384px more.
  expect(mapWidthFailures({ ...fitted, frameWidth: 792, columnWidth: 840 })).toEqual([]);
  // The map opens fitted, so its type under the floors at 1440 is recorded, not a failure (#655).
  expect(mapWidthFailures({ ...fitted, title: 8, text: 5 })).toEqual([]);
  expect(mapWidthFailures({ ...fitted, frameWidth: 792 })).toEqual([
    "the map's frame is 792px wide in a 1224px page column: it should span the column inside the gutters",
  ]);
});

test('waitForHealth throws at once when the server has exited', async () => {
  const started = Date.now();
  await expect(waitForHealth('http://127.0.0.1:1', () => true)).rejects.toThrow(
    'the server exited before answering /api/health',
  );
  expect(Date.now() - started).toBeLessThan(1000);
});

test('waitForHealth accepts a server that answers only after 20 seconds', async () => {
  const realFetch = globalThis.fetch;
  const realSleep = Bun.sleep;
  const start = Date.now();
  let clock = start;
  setSystemTime(new Date(clock));
  Bun.sleep = (async (ms: number) => {
    clock += ms;
    setSystemTime(new Date(clock));
  }) as typeof Bun.sleep;
  globalThis.fetch = (async () =>
    new Response('', { status: clock - start >= 20_000 ? 200 : 503 })) as unknown as typeof fetch;
  try {
    await waitForHealth('http://127.0.0.1:1', () => false);
    expect(clock - start).toBeGreaterThanOrEqual(20_000);
  } finally {
    globalThis.fetch = realFetch;
    Bun.sleep = realSleep;
    setSystemTime();
  }
});

test('openAtWidth sets the width, then loads the page and waits for it, so a probe never reads a remounting page', async () => {
  const calls: string[] = [];
  const page = {
    setViewport: async (w: number) => void calls.push(`viewport ${w}`),
    goto: async (url: string) => void calls.push(`goto ${url}`),
    evaluate: async (expression: string) => {
      calls.push(expression.includes('main[data-board]') ? 'ready' : 'other');
      return true;
    },
  } as unknown as import('../lib/cdp').Page;
  await openAtWidth(page, 'http://x/board', 760, 'main[data-board]');
  expect(calls).toEqual(['viewport 760', 'goto http://x/board', 'ready']);
});
