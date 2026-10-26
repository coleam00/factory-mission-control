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
  urlFactoryView,
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

/** The keys #79's contract checks: none of them is a factory. */
const NOT_FACTORIES = ['nope', ' mission-control', 'Mission-Control', 'x'.repeat(300), 'a/b'];
const SERVED = ['mission-control', 'second-factory'];
const view = (inUrl: string | undefined, listed: Listed, served: string[] | undefined = SERVED) =>
  urlFactoryView({ inUrl, listed, served });

test('a key the live list names shows its screen; one it does not name is unknown', () => {
  expect(view('second-factory', both)).toBe('screen');
  for (const key of NOT_FACTORIES) expect(view(key, both)).toBe('unknown');
});

test('a key the server serves is never unknown, even with no row in the live list', () => {
  const noRow: Listed = { status: 'ready', names: ['mission-control'] };
  expect(view('second-factory', noRow)).toBe('screen');
  expect(view('second-factory', { status: 'ready', names: [] })).toBe('screen');
  expect(view('second-factory', loading)).toBe('screen');
  // Served is the server's file as written: a recased or padded key is still not one of them.
  expect(view('Second-Factory', noRow)).toBe('unknown');
  expect(view(' second-factory', noRow)).toBe('unknown');
});

test('while the list loads nothing is unknown: a served key shows, any other waits', () => {
  expect(view('mission-control', loading)).toBe('screen');
  for (const key of NOT_FACTORIES) expect(view(key, loading)).toBe('waiting');
  // Before the server's configuration is in, no panel can seal, so nothing waits on it.
  expect(urlFactoryView({ inUrl: 'nope', listed: loading, served: undefined })).toBe('screen');
});

test('when the list fails the key cannot be checked, so the screen shows as before', () => {
  const failed: Listed = { status: 'error' };
  expect(view('mission-control', failed)).toBe('screen');
  for (const key of NOT_FACTORIES) expect(view(key, failed)).toBe('screen');
});

test('off a factory URL the screen shows', () => {
  expect(view(undefined, loading)).toBe('screen');
  expect(view(undefined, both)).toBe('screen');
});

test('a key that is not a factory is never remembered', () => {
  for (const key of NOT_FACTORIES) {
    expect(toRemember(key, both)).toBeUndefined();
    expect(toRemember(key, loading)).toBeUndefined();
    expect(toRemember(key, { status: 'error' })).toBeUndefined();
  }
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
