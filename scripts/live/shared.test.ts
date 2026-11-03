import { expect, test } from 'bun:test';
import { FACTORY_MAP } from '../../app/map/factory-map';
import { freePort, LIMITS, lateWrite, mapMismatches, type ShownCard } from './shared';

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
    'the map shows cards plan, ',
  );
});
