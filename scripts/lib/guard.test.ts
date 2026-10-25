import { expect, test } from 'bun:test';
import { isCheckBranch, RefusedBranch, requireCheckBranch } from './guard';

test.each(['check-abc', 'check-old', 'check-0a1b2c3d'])('accepts %s', (name) => {
  expect(isCheckBranch(name)).toBe(true);
  expect(() => requireCheckBranch(name)).not.toThrow();
});

test.each([
  'main',
  'fixture',
  'rewind-x',
  'rewind-2026-10-20T00:00Z',
  'check-',
  'Check-abc',
  'xcheck-a',
])('refuses %s', (name) => {
  expect(isCheckBranch(name)).toBe(false);
  expect(() => requireCheckBranch(name)).toThrow(RefusedBranch);
});
