import { expect, test } from 'bun:test';
import {
  isCheckBranch,
  isRewindBranch,
  RefusedBranch,
  requireCheckBranch,
  requireRewindBranch,
} from './guard';

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

test('accepts a rewind branch only as rewind-*', () => {
  expect(isRewindBranch('rewind-2026-10-25t12-00-00z')).toBe(true);
  expect(() => requireRewindBranch('rewind-2026-10-25t12-00-00z')).not.toThrow();
  for (const name of ['main', 'check-abc', 'rewind-', 'Rewind-x', 'rewind-x/y']) {
    expect(isRewindBranch(name)).toBe(false);
    expect(() => requireRewindBranch(name)).toThrow(RefusedBranch);
  }
});
