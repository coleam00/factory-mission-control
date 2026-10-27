import { expect, test } from 'bun:test';
import { formatCost, formatElapsed } from './format';

test.each([
  [0.1, '$0.10'],
  [0.125, '$0.125'],
  [0.0042, '$0.0042'],
  [1.3, '$1.30'],
  [12, '$12.00'],
  [0, '$0.00'],
  [0.01, '$0.01'],
  [0.001, '$0.001'],
  [0.0001, '$0.0001'],
  [0.00426, '$0.0043'],
  [0.9999, '$1.00'],
])('formatCost(%s) keeps cents and meaningful extra digits: %s', (usd, expected) => {
  expect(formatCost(usd)).toBe(expected);
});

test.each([
  [1_200, '0:20:00'],
  [3_600, '1:00:00'],
  [86_400 + 18 * 3_600 + 11 * 60 + 22, '1d 18:11:22'],
  [65, '0:01:05'],
  [3_725, '1:02:05'],
  [86_400 + 65, '1d 0:01:05'],
  [3 * 86_400 + 3_725, '3d 1:02:05'],
  [-5, '0:00:00'],
  [0, '0:00:00'],
  [59.9, '0:00:59'],
  [60, '0:01:00'],
  [3_599, '0:59:59'],
  [86_399, '23:59:59'],
  [86_400, '1d 0:00:00'],
])('formatElapsed(%s) always shows hours: %s', (seconds, expected) => {
  expect(formatElapsed(seconds)).toBe(expected);
});
