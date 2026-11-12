import { expect, test } from 'bun:test';
import { failuresSince, msToNextHour } from './failures';

test('the failure cutoff is 7 days back, cut down to the whole UTC hour, so no failure resolves early', () => {
  const now = new Date('2026-11-12T20:47:31.500Z');
  expect(failuresSince(now)).toBe('2026-11-05T20:00:00.000Z');
  expect(failuresSince(new Date('2026-11-12T21:00:00.000Z'))).toBe('2026-11-05T21:00:00.000Z');
  expect(new Date(failuresSince(now)).getTime()).toBeLessThanOrEqual(
    now.getTime() - 7 * 86_400_000,
  );
});

test('the cutoff moves on at the next whole UTC hour', () => {
  expect(msToNextHour(new Date('2026-11-12T20:47:00.000Z'))).toBe(13 * 60_000);
  expect(msToNextHour(new Date('2026-11-12T21:00:00.000Z'))).toBe(3_600_000);
});
