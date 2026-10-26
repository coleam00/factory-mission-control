import { expect, test } from 'bun:test';
import { openWaves } from './waves';

const WAVES = [['a', 'b'], ['c', 'd'], ['e']];

test('only the first wave is open until every panel in it has settled', () => {
  expect(openWaves(WAVES, new Set())).toBe(1);
  expect(openWaves(WAVES, new Set(['a']))).toBe(1);
  expect(openWaves(WAVES, new Set(['a', 'c', 'd']))).toBe(1);
});

test('each wave opens once the one before it has settled, up to the last', () => {
  expect(openWaves(WAVES, new Set(['a', 'b']))).toBe(2);
  expect(openWaves(WAVES, new Set(['a', 'b', 'c', 'd']))).toBe(3);
  expect(openWaves(WAVES, new Set(['a', 'b', 'c', 'd', 'e']))).toBe(3);
});
