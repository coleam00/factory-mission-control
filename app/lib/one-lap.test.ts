import { expect, test } from 'bun:test';
import {
  attemptSeconds,
  attemptsInOrder,
  consoleUrl,
  lapCost,
  prNumber,
  type StepAttemptRow,
} from './one-lap';

const RUN = '5eed0001-0000-4000-8000-000000000003';

const attempt = (over: Partial<StepAttemptRow>): StepAttemptRow => ({
  step_id: 'review',
  status: 'completed',
  started_at: new Date('2026-10-01T14:47:00Z'),
  duration_ms: 600_000,
  model: 'sonnet',
  tokens_input: 48_210,
  tokens_output: 6_904,
  tokens_cache_read: 39_877,
  tokens_cache_write: 8_333,
  cost_usd: '0.4',
  outcome: 'merge',
  error: null,
  ...over,
});

test('attempts run in start order, an attempt with no start last, ties by step', () => {
  const rows = [
    attempt({ step_id: 'ship', status: 'skipped', started_at: null }),
    attempt({ step_id: 'review', started_at: new Date('2026-10-01T15:00:00Z') }),
    attempt({ step_id: 'deploy', status: 'skipped', started_at: null }),
    attempt({ step_id: 'review', started_at: new Date('2026-10-01T14:00:00Z') }),
    attempt({ step_id: 'evidence', started_at: new Date('2026-10-01T14:00:00Z') }),
  ];
  expect(
    attemptsInOrder(rows).map((r) => [r.step_id, r.started_at?.toISOString() ?? null]),
  ).toEqual([
    ['evidence', '2026-10-01T14:00:00.000Z'],
    ['review', '2026-10-01T14:00:00.000Z'],
    ['review', '2026-10-01T15:00:00.000Z'],
    ['deploy', null],
    ['ship', null],
  ]);
});

test("the lap's cost sums every attempt, numeric strings and numbers alike", () => {
  expect(lapCost([attempt({ cost_usd: '0.4213' }), attempt({ cost_usd: 0.4213 })])).toBeCloseTo(
    0.8426,
  );
  expect(lapCost([attempt({ cost_usd: null }), attempt({ cost_usd: '1.2' })])).toBe(1.2);
  expect(lapCost([attempt({ cost_usd: null })])).toBeNull();
});

test("the console link is the factory's console, /console/r/, and the run id", () => {
  expect(consoleUrl('http://localhost:3090', RUN)).toBe(`http://localhost:3090/console/r/${RUN}`);
  expect(consoleUrl('http://localhost:3090/', RUN)).toBe(`http://localhost:3090/console/r/${RUN}`);
});

test('a pull request number is read from its #n text, and nothing else', () => {
  expect(prNumber('#103')).toBe(103);
  expect(prNumber('103')).toBe(103);
  expect(prNumber('')).toBeNull();
  expect(prNumber(null)).toBeNull();
  expect(prNumber('#103 and #104')).toBeNull();
});

test('a finished attempt takes its recorded duration; a running one its time so far', () => {
  const now = Date.parse('2026-10-25T12:03:04Z');
  expect(attemptSeconds(attempt({ duration_ms: '184250' }), now)).toBe(184.25);
  expect(
    attemptSeconds(
      attempt({
        status: 'running',
        started_at: new Date('2026-10-25T12:00:00Z'),
        duration_ms: null,
      }),
      now,
    ),
  ).toBe(184);
  expect(attemptSeconds(attempt({ status: 'skipped', duration_ms: null }), now)).toBeNull();
});
