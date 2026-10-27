import { expect, test } from 'bun:test';
import { costOf, durationOf, recentLaps, since, stepLabel } from './laps';

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

test('recent laps are ordered by finish, newest first, whatever order they started in (#116)', () => {
  const lap = (run_id: string, started_at: string, completed_at: string | null) => ({
    run_id,
    status: 'completed',
    started_at: new Date(started_at),
    completed_at: completed_at === null ? null : new Date(completed_at),
    issue_number: null,
    outcome: null,
    cost_usd: null,
  });
  expect(
    recentLaps([
      // Started last, finished first: a short lap that found nothing to do.
      lap('short', '2026-10-01T09:00:00Z', '2026-10-01T09:05:00Z'),
      // Started first, finished last: the lap that just merged.
      lap('merged', '2026-10-01T08:00:00Z', '2026-10-01T10:00:00Z'),
      lap('no-finish', '2026-10-01T11:00:00Z', null),
      lap('older', '2026-09-30T08:00:00Z', '2026-09-30T09:00:00Z'),
    ]).map((l) => l.run_id),
  ).toEqual(['merged', 'short', 'older', 'no-finish']);
});
