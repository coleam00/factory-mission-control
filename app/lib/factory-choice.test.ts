import { expect, test } from 'bun:test';
import {
  currentFactory,
  type Listed,
  REMEMBERED_KEY,
  readRemembered,
  remember,
  shownRows,
  switcherEntries,
  toRemember,
} from './factory-choice';

const loading: Listed = { status: 'loading' };
const both: Listed = { status: 'ready', names: ['mission-control', 'second-factory'] };
const pick = (remembered: string | undefined, listed: Listed, inUrl?: string) =>
  currentFactory({ inUrl, remembered, fallback: 'mission-control', listed });

test("the URL's factory wins over the remembered one", () => {
  expect(pick('second-factory', both, 'third')).toBe('third');
  expect(pick(undefined, loading, 'second-factory')).toBe('second-factory');
});

test('with nothing remembered, or the default remembered, the default shows at once', () => {
  expect(pick(undefined, loading)).toBe('mission-control');
  expect(pick('mission-control', loading)).toBe('mission-control');
});

test('a remembered factory waits for the list, then shows if listed and falls back if not', () => {
  expect(pick('second-factory', loading)).toBeUndefined();
  expect(pick('second-factory', both)).toBe('second-factory');
  expect(pick('removed-factory', both)).toBe('mission-control');
  expect(pick('second-factory', { status: 'error' })).toBe('mission-control');
});

test('only a listed factory in the URL is remembered', () => {
  expect(toRemember('second-factory', both)).toBe('second-factory');
  expect(toRemember('typo', both)).toBeUndefined();
  expect(toRemember('second-factory', loading)).toBeUndefined();
  expect(toRemember(undefined, both)).toBeUndefined();
});

test('the choice round-trips through storage, and a throwing storage remembers nothing', () => {
  const items = new Map<string, string>();
  const storage = {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
  };
  expect(readRemembered(storage)).toBeUndefined();
  remember(storage, 'second-factory');
  expect(items.get(REMEMBERED_KEY)).toBe('second-factory');
  expect(readRemembered(storage)).toBe('second-factory');

  const throwing = {
    getItem: () => {
      throw new Error('denied');
    },
    setItem: () => {
      throw new Error('denied');
    },
  };
  expect(readRemembered(throwing)).toBeUndefined();
  expect(() => remember(throwing, 'second-factory')).not.toThrow();
  expect(readRemembered(undefined)).toBeUndefined();
});

test('the switcher lists the default first, then by name', () => {
  const rows = [
    { factory: 'zeta', is_default: false },
    { factory: 'mission-control', is_default: true },
    { factory: 'alpha', is_default: false },
  ];
  expect(switcherEntries(rows).map((r) => r.factory)).toEqual(['mission-control', 'alpha', 'zeta']);
});

test('the switcher lists only the rows the server shows: one factory in the file lists one', () => {
  const rows = [
    { factory: 'mission-control', running: 3 },
    { factory: 'second-factory', running: 1 },
  ];
  expect(shownRows(rows, ['mission-control'])).toEqual([
    { factory: 'mission-control', running: 3 },
  ]);
  expect(shownRows(rows, ['mission-control', 'second-factory'])).toEqual(rows);
  expect(shownRows(rows, undefined)).toBeUndefined();
  expect(shownRows(undefined, ['mission-control'])).toBeUndefined();
});
