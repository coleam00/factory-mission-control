import { expect, test } from 'bun:test';
import {
  type Cause,
  causeOf,
  countByCause,
  failedLaps,
  type HealthRunRow,
  type HealthStepRow,
  overdueSteps,
  p90,
  usualDurations,
  waitingRuns,
  workable,
} from './health';

test('the cause classifier follows the PRD: usage limit, authentication, infrastructure, other', () => {
  expect(causeOf('HTTP 429')).toBe('usage-limit');
  expect(causeOf('401 Unauthorized')).toBe('authentication');
  expect(causeOf('fetch failed')).toBe('infrastructure');
  expect(causeOf('boom')).toBe('other');
});

test.each<[string | null, Cause]>([
  ['usage limit reached', 'usage-limit'],
  ['unauthorized: invalid x-api-key', 'authentication'],
  ['connect ECONNREFUSED 127.0.0.1:5432', 'infrastructure'],
  ['read ETIMEDOUT', 'infrastructure'],
  // The first pattern that matches decides.
  ['fetch failed: 429 Too Many Requests', 'usage-limit'],
  [null, 'other'],
])('%p is %p', (error, cause) => {
  expect(causeOf(error)).toBe(cause);
});

test('p90 is the nearest-rank 90th percentile', () => {
  expect(p90([])).toBeNull();
  expect(p90([7])).toBe(7);
  expect(p90([10, 1, 9, 2, 8, 3, 7, 4, 6, 5])).toBe(9);
  expect(p90([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])).toBe(10);
});

const MINUTE = 60_000;
const START = Date.parse('2026-10-01T00:00:00Z');

/** `n` completions of build, one an hour, the newest last; `duration(i)` gives the i-th's ms. */
const completions = (n: number, duration: (i: number) => number): HealthStepRow[] =>
  Array.from({ length: n }, (_, i) => ({
    kind: 'completion',
    run_id: `run-${String(i).padStart(3, '0')}`,
    workflow_name: 'archon-loop',
    step_id: 'build',
    at: new Date(START + i * 60 * MINUTE),
    duration_ms: duration(i),
  }));

const running = (startedAt: number, step = 'build'): HealthStepRow => ({
  kind: 'running',
  run_id: 'run-live',
  workflow_name: 'archon-loop',
  step_id: step,
  at: new Date(startedAt),
  duration_ms: null,
});

test('the p90 rule reads only the latest 50 completions', () => {
  // Ten old 100-minute completions, then fifty of 10 minutes: only the fifty count.
  const rows = completions(60, (i) => (i < 10 ? 100 : 10) * MINUTE).reverse();
  expect(usualDurations(rows).get('archon-loop build')).toEqual({
    p90: 10 * MINUTE,
    completions: 50,
  });
  const startedAt = START + 100 * 60 * MINUTE;
  expect(overdueSteps([...rows, running(startedAt)], startedAt + 21 * MINUTE)).toHaveLength(1);
  expect(overdueSteps([...rows, running(startedAt)], startedAt + 20 * MINUTE)).toEqual([]);
});

test('a running step is overdue only past twice its p90, and a step with no completion never is', () => {
  const rows = [...completions(10, (i) => (i + 1) * MINUTE), running(0), running(0, 'review')];
  // p90 of 1..10 minutes is 9 minutes: overdue past 18.
  expect(overdueSteps(rows, 18 * MINUTE)).toEqual([]);
  expect(overdueSteps(rows, 18 * MINUTE + 1)).toEqual([
    {
      run_id: 'run-live',
      workflow_name: 'archon-loop',
      step_id: 'build',
      started_at: new Date(0),
      running_ms: 18 * MINUTE + 1,
      p90_ms: 9 * MINUTE,
      completions: 10,
    },
  ]);
});

test("a step's usual time is its own workflow's", () => {
  const manager = completions(5, () => 60 * MINUTE).map((row) => ({
    ...row,
    workflow_name: 'archon-manager',
  }));
  const rows = [...completions(5, () => MINUTE), ...manager, running(0)];
  expect(overdueSteps(rows, 3 * MINUTE).map((step) => step.p90_ms)).toEqual([MINUTE]);
});

const run = (overrides: Partial<HealthRunRow>): HealthRunRow => ({
  run_id: 'r',
  workflow_name: 'archon-loop',
  status: 'failed',
  started_at: null,
  completed_at: null,
  failed_step: null,
  error: null,
  failed_at: null,
  ...overrides,
});

test('failed laps are failed runs and runs with a failed step, newest first, each with its cause', () => {
  const rows = [
    run({ run_id: 'a', failed_step: 'build', error: '429', failed_at: new Date(1000) }),
    run({ run_id: 'b', status: 'pending' }),
    run({
      run_id: 'c',
      status: 'running',
      failed_step: 'deploy',
      error: 'ECONNRESET',
      failed_at: new Date(3000),
    }),
    run({ run_id: 'd', completed_at: new Date(2000) }),
  ];
  const laps = failedLaps(rows);
  expect(laps.map((lap) => [lap.run_id, lap.cause])).toEqual([
    ['c', 'infrastructure'],
    ['d', 'other'],
    ['a', 'usage-limit'],
  ]);
  expect(countByCause(laps)).toEqual({
    'usage-limit': 1,
    authentication: 0,
    infrastructure: 1,
    other: 1,
  });
});

test('waiting runs: pending, then paused, each oldest first', () => {
  const rows = [
    run({ run_id: 'p2', status: 'paused', started_at: new Date(2000) }),
    run({ run_id: 'q', status: 'pending', started_at: new Date(3000) }),
    run({ run_id: 'p1', status: 'paused', started_at: new Date(1000) }),
    run({ run_id: 'f', status: 'failed' }),
  ];
  expect(waitingRuns(rows).map((r) => r.run_id)).toEqual(['q', 'p1', 'p2']);
});

test('workable issues by number, against the running laps', () => {
  expect(
    workable([
      { kind: 'issue', issue_number: 18, title: 'b', url: 'u18', run_id: null },
      { kind: 'lap', issue_number: null, title: null, url: null, run_id: 'x' },
      { kind: 'issue', issue_number: 9, title: 'a', url: 'u9', run_id: null },
    ]),
  ).toEqual({
    issues: [
      { issue_number: 9, title: 'a', url: 'u9' },
      { issue_number: 18, title: 'b', url: 'u18' },
    ],
    running: 1,
  });
});
