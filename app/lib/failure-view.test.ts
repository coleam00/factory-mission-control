import { expect, test } from 'bun:test';
import { failureCards, failureWhen, retriedLine } from './failure-view';
import type { FailureGroupRow } from './failures';

const RUN = '5eed0005-0000-4000-8000-000000000001';

const group = (overrides: Partial<FailureGroupRow> = {}): FailureGroupRow => ({
  signature: 'sig',
  workflow_name: 'archon-loop',
  step_id: 'review',
  class: 'transient',
  failures: 3,
  first_at: new Date('2026-10-22T23:00:00Z'),
  last_at: new Date('2026-10-24T01:00:00Z'),
  latest_run_id: RUN,
  line: 'boom',
  last_day: new Date('2026-10-24'),
  daily: [0, 1, 2],
  console: 'http://localhost:3090/',
  ...overrides,
});

test('a failure card names the step, the class and the latest run, and says its age in words', () => {
  const [card] = failureCards([group()], 'f');
  expect(card?.title).toBe('Lap failed at review');
  expect(card?.pill).toEqual({ label: 'transient', state: 'failed' });
  expect(card?.href).toBe(`/f/f/runs/${RUN}`);
  const now = Date.parse('2026-10-24T04:12:00Z');
  expect(failureWhen({ failures: 3, lastAt: card?.lastAt ?? null }, now)).toBe(
    '3 runs, last 3h 12m ago',
  );
  expect(failureWhen({ failures: 1, lastAt: new Date(now - 5 * 60_000) }, now)).toBe(
    '1 run, last 5m ago',
  );

  const [bare] = failureCards(
    [group({ step_id: null, class: null, failures: 1, line: null })],
    'f',
  );
  expect(bare?.title).toBe('Lap failed');
  expect(bare?.pill).toEqual({ label: 'unclassified', state: 'failed' });
});

test('cards come newest first', () => {
  const cards = failureCards(
    [
      group({ signature: 'old', last_at: new Date('2026-10-20T00:00:00Z'), failures: 9 }),
      group({ signature: 'new', last_at: new Date('2026-10-24T00:00:00Z'), failures: 1 }),
    ],
    'f',
  );
  expect(cards.map((c) => c.key)).toEqual(['new', 'old']);
});

test('retriedLine words one run and many', () => {
  expect(retriedLine(1)).toBe(
    '1 run hit a passing database or GitHub error today and was retried.',
  );
  expect(retriedLine(3)).toBe(
    '3 runs hit a passing database or GitHub error today and were retried.',
  );
});
