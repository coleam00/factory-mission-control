import { expect, test } from 'bun:test';
import {
  attemptSeconds,
  attemptsInOrder,
  type CheckLineRow,
  checkLineFor,
  consoleUrl,
  lapCost,
  lapOutcome,
  type OneLapRow,
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
  position: null,
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

test("an attempt with no start goes in the loop's order, a step the version lacks after (#191)", () => {
  const rows = [
    attempt({ step_id: 'tally', status: 'skipped', started_at: null, position: 83 }),
    attempt({ step_id: 'briefs', status: 'skipped', started_at: null }),
    attempt({ step_id: 'deploy', status: 'skipped', started_at: null, position: 77 }),
    attempt({ step_id: 'ship', status: 'skipped', started_at: null, position: 3 }),
    attempt({ step_id: 'build', started_at: new Date('2026-10-01T14:00:00Z'), position: 2 }),
    attempt({ step_id: 'pick', started_at: new Date('2026-10-01T15:00:00Z'), position: 0 }),
  ];
  expect(attemptsInOrder(rows).map((r) => r.step_id)).toEqual([
    'build',
    'pick',
    'ship',
    'deploy',
    'tally',
    'briefs',
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

test('a pull request number is read from its #n text or its URL, and nothing else', () => {
  expect(prNumber('#103')).toBe(103);
  expect(prNumber('103')).toBe(103);
  expect(prNumber('https://github.com/coleam00/factory-mission-control/pull/103')).toBe(103);
  expect(prNumber('https://github.com/coleam00/factory-mission-control/pull/103/')).toBe(103);
  expect(prNumber('https://github.com/coleam00/factory-mission-control/issues/103')).toBeNull();
  expect(prNumber('#103/')).toBeNull();
  expect(prNumber('')).toBeNull();
  expect(prNumber(null)).toBeNull();
  expect(prNumber('#103 and #104')).toBeNull();
});

test('a pull request written as a JSON object is read from its number or url field', () => {
  expect(prNumber('{"repo": {"host": "github.com"}, "number": 293}')).toBe(293);
  expect(prNumber('{"url": "https://github.com/coleam00/factory-mission-control/pull/293"}')).toBe(
    293,
  );
  expect(prNumber('{"repo": {"host": "github.com"}}')).toBeNull();
  expect(prNumber('{"number": "293"}')).toBeNull();
  expect(prNumber('{not json')).toBeNull();
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

const lap = (over: Partial<OneLapRow>): OneLapRow => ({
  run_id: RUN,
  status: 'completed',
  started_at: null,
  completed_at: null,
  repository: 'coleam00/factory-mission-control',
  console: 'http://localhost:3090',
  issue_number: null,
  issue_title: null,
  issue_url: null,
  route: 'simple',
  depth: null,
  pr: null,
  review_status: null,
  review_outcome: null,
  review_delivers: null,
  dispositions: null,
  gate_status: null,
  gate_outcome: null,
  gate_reason: null,
  ...over,
});

test("a lap's outcome reads as recent-laps.sql's CASE: failure, gate, review, then route none", () => {
  const cases: [Partial<OneLapRow>, ReturnType<typeof lapOutcome>][] = [
    [{ status: 'running', gate_outcome: 'merged' }, null],
    [{ status: 'failed', gate_outcome: 'merged' }, 'failed'],
    [{ review_outcome: 'merge', gate_outcome: 'merged' }, 'merged'],
    [{ review_outcome: 'merge', gate_outcome: 'refused' }, 'gate-refused'],
    [{ review_outcome: 'sent-back' }, 'sent-back'],
    [{ review_outcome: 'needs-owner' }, 'needs-owner'],
    [{ status: 'cancelled', route: 'none' }, 'nothing'],
    [{ review_outcome: 'merge' }, null],
  ];
  for (const [over, outcome] of cases) expect(lapOutcome(lap(over))).toBe(outcome);
});

const check = (position: number, line_id: string | null): CheckLineRow => ({
  position,
  line_id,
  kind: 'holdout',
  verdict: 'FAIL',
  evidence_count: 1,
  scenario_id: 'H-02',
});

test('a disposition answers the one check line with its id, and no line when none or several do', () => {
  const lines = [check(1, 'C1'), check(4, 'H2'), check(5, null)];
  expect(checkLineFor('H2', lines)).toEqual(check(4, 'H2'));
  expect(checkLineFor('H9', lines)).toBeNull();
  expect(checkLineFor(null, lines)).toBeNull();
  expect(checkLineFor('H2', [check(2, 'H2'), check(4, 'H2')])).toBeNull();
  expect(checkLineFor('H2', [check(1, null), check(2, null)])).toBeNull();
  expect(checkLineFor('H2', [])).toBeNull();
});
