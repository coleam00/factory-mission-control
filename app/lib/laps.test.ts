import { expect, test } from 'bun:test';
import { costOf, durationOf, formatSpan, recentLaps, since, stepLabel } from './laps';

test('formatSpan counts days past a day and pads hours under it', () => {
  expect(formatSpan(65)).toBe('01:05');
  expect(formatSpan(3_725)).toBe('01:02:05');
  expect(formatSpan(86_400 + 65)).toBe('1d 00:01:05');
  expect(formatSpan(3 * 86_400 + 3_725)).toBe('3d 01:02:05');
  expect(formatSpan(-5)).toBe('00:00');
});

test('since and durationOf do the clock math the queries leave out', () => {
  const now = Date.parse('2026-10-24T12:00:00Z');
  expect(since(new Date('2026-10-24T11:58:30Z'), now)).toBe(90);
  expect(since(null, now)).toBeNull();
  expect(
    durationOf({
      started_at: new Date('2026-10-01T08:00:00Z'),
      completed_at: new Date('2026-10-01T09:30:00Z'),
    }),
  ).toBe(5_400);
  expect(
    durationOf({ started_at: new Date('2026-10-01T08:00:00Z'), completed_at: null }),
  ).toBeNull();
});

test('costOf reads numeric strings and keeps a lap with no costed step at null', () => {
  expect(costOf('2.5')).toBe(2.5);
  expect(costOf(0.1)).toBe(0.1);
  expect(costOf(null)).toBeNull();
});

test('a nested step reads as its path', () => {
  expect(stepLabel('ship__intel')).toBe('ship / intel');
  expect(stepLabel('review')).toBe('review');
});

test('recent laps are newest first, a lap with no start last, ties by run id', () => {
  const lap = (run_id: string, started_at: Date | null) => ({
    run_id,
    status: 'completed',
    started_at,
    completed_at: null,
    issue_number: null,
    outcome: null,
    cost_usd: null,
  });
  expect(
    recentLaps([
      lap('a', new Date('2026-10-01T08:00:00Z')),
      lap('c', null),
      lap('d', new Date('2026-10-02T08:00:00Z')),
      lap('b', new Date('2026-10-01T08:00:00Z')),
    ]).map((l) => l.run_id),
  ).toEqual(['d', 'a', 'b', 'c']);
});
