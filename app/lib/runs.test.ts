import { expect, test } from 'bun:test';
import {
  formatTook,
  type RunRow,
  RUNS_PAGE_SIZE,
  runsArgs,
  runsView,
  type RunsRow,
  stopLine,
  subLine,
  took,
} from './runs';

const run = (over: Partial<RunRow> = {}): RunRow => ({
  all_count: 1,
  running_count: 0,
  needs_you_count: 0,
  failed_count: 0,
  done_count: 1,
  idle_count: 0,
  idle_polls: 0,
  run_id: '5eed0003-0000-4000-8000-00000000000a',
  position: 1,
  workflow_name: 'archon-build-queue',
  status: 'completed',
  state: 'done',
  idle_poll: false,
  started_at: null,
  completed_at: null,
  issue_number: null,
  issue_title: null,
  stop_step: null,
  stop_line: null,
  round: null,
  step_id: null,
  pr_number: null,
  cost_usd: null,
  ...over,
});

test('a duration reads in at most two units', () => {
  expect([0, 39, 59.9, 60, 2760, 11520, 11580, 90000, 86400].map(formatTook)).toEqual([
    '0s',
    '39s',
    '59s',
    '1m',
    '46m',
    '3h 12m',
    '3h 13m',
    '1d 1h',
    '1d',
  ]);
});

test('took runs to the end, or to now while the run has none, and is nothing without a start', () => {
  const started_at = new Date('2026-10-01T10:00:00Z');
  const now = Date.parse('2026-10-01T10:00:39Z');
  expect(took({ started_at, completed_at: new Date('2026-10-01T10:46:00Z') }, now)).toBe('46m');
  expect(took({ started_at, completed_at: null }, now)).toBe('39s');
  expect(took({ started_at: null, completed_at: null }, now)).toBeNull();
});

test('the sub-line joins what is known: round, the raw last step segment, the pull request', () => {
  expect(subLine(run())).toBe('');
  expect(
    subLine(
      run({
        state: 'running',
        round: '2',
        step_id: 'ship__deliver__rounds.review__synthesize',
        pr_number: 530,
      }),
    ),
  ).toBe('round 2 · review__synthesize · PR #530');
  // A stopped run names the step that stopped it, not the last one it started.
  expect(subLine(run({ state: 'failed', stop_step: 'build', step_id: 'land' }))).toBe('build');
  expect(subLine(run({ state: 'failed', stop_step: null, step_id: 'land' }))).toBe('land');
});

test('the stop line is the error of a failed run and the question of a paused one', () => {
  expect(stopLine(run({ state: 'failed', stop_line: 'boom' }))).toBe('boom');
  expect(stopLine(run({ state: 'failed' }))).toBeNull();
  expect(stopLine(run({ state: 'needs-you', stop_line: 'Merge it?' }))).toBe('Asking: Merge it?');
  expect(
    stopLine(run({ state: 'needs-you', stop_line: '**Merge queue, PR 16: merge decision**' })),
  ).toBe('Asking: Merge queue, PR 16: merge decision');
  expect(stopLine(run({ state: 'needs-you' }))).toBe('Waiting on you');
  expect(stopLine(run({ state: 'done', stop_line: 'x' }))).toBeNull();
});

test('the arguments hide idle polls and count pages from 0', () => {
  expect(runsArgs({ q: '', state: '', hideIdle: true, page: 1 })).toEqual([
    '',
    '',
    'hide',
    '0',
    String(RUNS_PAGE_SIZE),
  ]);
  expect(runsArgs({ q: 'a', state: 'failed', hideIdle: false, page: 3 })).toEqual([
    'a',
    'failed',
    'show',
    '2',
    String(RUNS_PAGE_SIZE),
  ]);
});

test('the view sorts by position and drops the row an empty page returns, keeping its counts', () => {
  const rows: RunsRow[] = [run({ position: 2, run_id: 'b' }), run({ position: 1, run_id: 'a' })];
  expect(runsView(rows).runs.map((r) => r.run_id)).toEqual(['a', 'b']);
  const empty = run({ run_id: null as never, position: null as never, all_count: 7 });
  expect(runsView([empty])).toMatchObject({ runs: [], counts: { all_count: 7 } });
});
