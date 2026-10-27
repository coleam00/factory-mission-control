import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { formatCost, formatCount, formatElapsed, formatNumber, formatSigned } from './format';

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
  [-0.00001, '0'],
  [0.00004, '0'],
])('formatNumber(%s) keeps four decimals at most and no trailing zero: %s', (n, expected) => {
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
