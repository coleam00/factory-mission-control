import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  clock,
  formatCost,
  formatCount,
  formatElapsed,
  formatNumber,
  formatSigned,
  localDay,
  localDayStart,
  localMinute,
  localSecond,
  weekdayClock,
} from './format';
import { pinZone } from './pin-zone';

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

test.each([
  [3, '3'],
  [0, '0'],
  [1.5, '1.5'],
  [0.25, '0.25'],
  [0.2667, '0.2667'],
  [3.75, '3.75'],
  [100, '100'],
])('formatNumber(%s) writes no trailing zero: %s', (n, expected) => {
  expect(formatNumber(n)).toBe(expected);
});

test.each([
  [0, '0'],
  [12_345, '12,345'],
  ['1234567', '1,234,567'],
])('formatCount(%p) writes a whole count with thousands separators: %s', (n, expected) => {
  expect(formatCount(n)).toBe(expected);
});

test.each([
  [1, formatNumber, '+1'],
  [0, formatNumber, '0'],
  [-2, formatNumber, '-2'],
  [-0.5, formatNumber, '-0.5'],
  [-3.1, formatCost, '-$3.10'],
  [0.005, formatCost, '+$0.005'],
  [0, formatCost, '$0.00'],
])('formatSigned(%s) puts the sign before the written size', (n, format, expected) => {
  expect(formatSigned(n, format)).toBe(expected);
});

describe('times in the viewer zone', () => {
  pinZone('America/Chicago');

  test('a time reads in the local zone, and midnight is 00:00', () => {
    expect(clock(new Date('2026-11-12T13:29:00Z'))).toBe('07:29');
    expect(clock(new Date('2026-11-12T06:00:00Z'))).toBe('00:00');
    expect(clock(null)).toBe('');
  });

  test('a day, a weekday and a second read in the local zone', () => {
    expect(localDay(new Date('2026-11-12T04:40:00Z'))).toBe('2026-11-11');
    expect(weekdayClock(new Date('2026-11-12T04:40:00Z'))).toBe('Wed 22:40');
    expect(localMinute(new Date('2026-11-12T13:29:00Z'))).toBe('2026-11-12 07:29');
    expect(localSecond(new Date('2026-11-12T13:29:05Z'))).toBe('2026-11-12 07:29:05');
  });

  test('the local day starts at local midnight, on a daylight-saving day too', () => {
    expect(localDayStart(new Date('2026-11-12T15:00:00Z'))).toBe('2026-11-12T06:00:00.000Z');
    expect(localDayStart(new Date('2026-11-01T18:00:00Z'))).toBe('2026-11-01T05:00:00.000Z');
  });
});

const appDir = resolve(import.meta.dir, '..');

/** What writes a number or a dollar amount itself, instead of through `format.ts`. */
const OWN_FORMATS = [
  /\.toFixed\(/,
  /\$\$\{/,
  />\s*\$\{/,
  /['"`]\$\d+\.\d/,
  /['"`]\$['"`]\s*(?:\+|\}|\.concat\()/,
  /\.toLocaleString\(/,
  /Intl\.NumberFormat/,
];
const formatsItself = (source: string) => OWN_FORMATS.some((pattern) => pattern.test(source));

test('no file in app/ but format.ts writes a number itself or builds a $ amount', () => {
  const offenders = [...new Bun.Glob('**/*.{ts,tsx}').scanSync(appDir)]
    .map((file) => file.replaceAll('\\', '/'))
    .filter((file) => file !== 'lib/format.ts' && !/\.test\.tsx?$/.test(file))
    .filter((file) => formatsItself(readFileSync(join(appDir, file), 'utf-8')));
  expect(offenders).toEqual([]);
});

test.each([
  ['value.toFixed(4)', true],
  ['`$${value}`', true],
  [`<span>\${cost}</span>`, true],
  ["cost === null ? '$0.00' : text", true],
  ["'$' + cost", true],
  ["<span>{'$'}{cost}</span>", true],
  ["'$'.concat(cost)", true],
  ["Number(n).toLocaleString('en-US')", true],
  ["new Intl.NumberFormat('en-US').format(n)", true],
  ["new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })", true],
  [`\`\${a} and \${b}\``, false],
  ["bash: '$',", false],
  ["segment.startsWith('$')", false],
  ['the factory (`$2` on)', false],
])('the format guard reads %p as writing a number itself: %p', (source, found) => {
  expect(formatsItself(source)).toBe(found);
});

/** What formats a time or a date itself, instead of through `format.ts`. */
const OWN_TIME_FORMATS = [
  /\.toISOString\(\)\s*\.slice\(/,
  /\bgetUTC(?:FullYear|Month|Date|Day|Hours|Minutes|Seconds)\(/,
  /\.toLocale(?:Time|Date)String\(/,
];
const formatsTimeItself = (source: string) =>
  OWN_TIME_FORMATS.some((pattern) => pattern.test(source));

// factory-scorecard.ts builds its UTC-day window key on purpose: the scorecard counts whole UTC days.
const UTC_ON_PURPOSE = ['lib/format.ts', 'lib/factory-scorecard.ts'];

test('no file in app/ but format.ts formats a time or date itself', () => {
  const offenders = [...new Bun.Glob('**/*.{ts,tsx}').scanSync(appDir)]
    .map((file) => file.replaceAll('\\', '/'))
    .filter((file) => !UTC_ON_PURPOSE.includes(file) && !/\.test\.tsx?$/.test(file))
    .filter((file) => formatsTimeItself(readFileSync(join(appDir, file), 'utf-8')));
  expect(offenders).toEqual([]);
});

test.each([
  ['at.toISOString().slice(11, 16)', true],
  ['WEEKDAYS[at.getUTCDay()]', true],
  ["d.toLocaleDateString([], { month: 'short' })", true],
  ['at.toISOString()', false],
  ['dateTime={event.at.toISOString()}', false],
])('the time guard reads %p as formatting a time itself: %p', (source, found) => {
  expect(formatsTimeItself(source)).toBe(found);
});
