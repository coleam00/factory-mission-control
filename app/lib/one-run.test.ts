import { expect, test } from 'bun:test';
import type { LapMapRow } from './lap-graph';
import type { OneLapRow, StepAttemptRow } from './one-lap';
import {
  managerRead,
  collapseSkipped,
  resumeEstimate,
  runCost,
  runTimeline,
  runTitle,
  runTokens,
  skipReason,
  stepCost,
} from './one-run';

const GROUP = 'ship__deliver__rounds';
let minute = 0;
const step = (step_id: string, over: Partial<StepAttemptRow> = {}): StepAttemptRow => ({
  step_id,
  status: 'completed',
  started_at: new Date(Date.UTC(2026, 9, 20, 10, minute++)),
  duration_ms: 60_000,
  model: null,
  tokens_input: 1000,
  tokens_output: null,
  tokens_cache_read: null,
  tokens_cache_write: null,
  cost_usd: '1',
  outcome: null,
  error: null,
  position: null,
  ...over,
});

const lap = (over: Partial<OneLapRow> = {}): OneLapRow => ({
  run_id: '5eed0005-0000-4000-8000-000000000017',
  workflow_name: 'archon-build-queue',
  status: 'failed',
  started_at: null,
  completed_at: null,
  repository: 'o/r',
  console: 'http://c',
  issue_number: 485,
  issue_title: null,
  issue_url: null,
  route: null,
  depth: null,
  pr_number: null,
  review_status: null,
  review_outcome: null,
  review_delivers: null,
  dispositions: null,
  hidden_lines: [],
  gate_status: null,
  gate_outcome: null,
  gate_reason: null,
  stop_status: null,
  stop_step: null,
  stop_line: null,
  stop_class: null,
  capacity_since: null,
  ...over,
});

/** Two rounds; round 2 fails at pr__prepare and its review is skipped. */
const failedBuild = () => {
  minute = 0;
  return [
    step('facts', { cost_usd: null }),
    step(`${GROUP}.implement`, { cost_usd: '5' }),
    step(`${GROUP}.pr__prepare`, { cost_usd: '0.5' }),
    step(`${GROUP}.review__result`, { cost_usd: '1.5' }),
    step(`${GROUP}.round`, { cost_usd: '0.25' }),
    step(`${GROUP}.implement`, { cost_usd: '6' }),
    step(`${GROUP}.pr__prepare`, { status: 'failed', cost_usd: '0.5', error: 'boom\nmore' }),
    step(`${GROUP}.review__result`, { status: 'skipped', cost_usd: null, duration_ms: 0 }),
  ];
};

const roundSizes = (rows: StepAttemptRow[]) => {
  const loop = runTimeline(rows).find((e) => e.kind === 'loop');
  return loop?.kind === 'loop' ? loop.rounds.map((r) => r.rows.length) : [];
};

test("a loop's roll-up is left out of a run's cost and tokens, however the row reaches the page", () => {
  minute = 0;
  const rows = [
    step('route', { cost_usd: '0.4' }),
    step(`${GROUP}.round`, { cost_usd: '1.5' }),
    // The step row of an unfinished loop node still holds the roll-up (0030).
    step(GROUP, { cost_usd: 1.5, tokens_input: 999 }),
    step('answer', { cost_usd: '0.3', tokens_input: null }),
  ];
  expect(stepCost(rows[2] as StepAttemptRow, rows)).toBeNull();
  expect(runCost(rows)).toBeCloseTo(2.2, 6);
  expect(runTokens(rows)).toBe(2000);
  expect(runCost(rows)).toBeCloseTo(
    rows.reduce((sum, r) => sum + (stepCost(r, rows) ?? 0), 0),
    6,
  );
  expect(runCost([step('route', { cost_usd: null })])).toBeNull();
});

test('a body step that runs again starts a round, but a retry straight after its failure stays in its round', () => {
  expect(roundSizes(failedBuild())).toEqual([4, 3]);
  minute = 0;
  const retried = [
    step(`${GROUP}.implement`),
    step(`${GROUP}.pr__prepare`, { status: 'failed' }),
    step(`${GROUP}.pr__prepare`),
    step(`${GROUP}.review__result`),
  ];
  expect(roundSizes(retried)).toEqual([4]);
});

test('a skipped body step with no start stays in the round whose event it ended in', () => {
  minute = 0;
  const at = (m: number) => new Date(Date.UTC(2026, 9, 20, 11, m));
  const rows = [
    step(`${GROUP}.implement`),
    step(`${GROUP}.pr__prepare`, { status: 'skipped', started_at: null, event_at: at(1) }),
    step(`${GROUP}.review__result`),
    step(`${GROUP}.implement`, { started_at: at(5) }),
    step(`${GROUP}.pr__prepare`, { started_at: at(6) }),
    step(`${GROUP}.review__result`, { started_at: at(7) }),
  ];
  expect(roundSizes(rows)).toEqual([3, 3]);
});

test('resuming re-runs the earlier round from the failed step on; with no earlier round there is no cost', () => {
  const rows = failedBuild();
  const failed = rows.find((r) => r.status === 'failed') as StepAttemptRow;
  expect(resumeEstimate(failed, rows, runTimeline(rows))).toEqual({
    step: 'pr__prepare',
    cost: 2.25,
  });
  minute = 0;
  const top = [step('build', { status: 'failed', cost_usd: '3' })];
  expect(resumeEstimate(top[0] as StepAttemptRow, top, runTimeline(top))).toEqual({
    step: 'build',
    cost: null,
  });
});

test('a skipped step says why: a failure before it, its map condition, its trigger rule, or nothing (null)', () => {
  const rows = failedBuild();
  expect(skipReason(rows.at(-1) as StepAttemptRow, rows, [])).toBe('upstream failed');
  const alone = [step('land', { status: 'skipped' })];
  const node = (over: Partial<LapMapRow>): LapMapRow => ({
    pin: 'p',
    archon_sha: 'a1',
    path: 'land',
    parent_path: null,
    position: 1,
    step_id: 'land',
    kind: 'script',
    depends_on: [],
    ...over,
  });
  const row = alone[0] as StepAttemptRow;
  expect(skipReason(row, alone, [node({ when_condition: '$a == 1' })])).toBe('when: $a == 1');
  expect(skipReason(row, alone, [node({ trigger_rule: 'all_success' })])).toBe(
    'trigger rule all_success',
  );
  expect(skipReason(row, alone, [])).toBeNull();
});

test('consecutive skipped items collapse into one group; others pass through', () => {
  const kinds = ['ran', 'skip', 'skip', 'ran', 'skip'];
  expect(collapseSkipped(kinds, (kind) => kind === 'skip')).toEqual([
    'ran',
    { skipped: ['skip', 'skip'] },
    'ran',
    { skipped: ['skip'] },
  ]);
});

test("a build's round carries the cap its pinned map holds, and none when the map holds none", () => {
  const loop = (round_cap: number | null): LapMapRow => ({
    pin: 'p',
    archon_sha: 'a1',
    path: 'ship/deliver/rounds',
    parent_path: 'ship/deliver',
    position: 1,
    step_id: 'rounds',
    kind: 'loop_group',
    depends_on: [],
    round_cap,
  });
  const timeline = runTimeline(failedBuild());
  expect(runTitle(lap(), timeline, [loop(3)])).toBe('Build #485, round 2 of 3');
  expect(runTitle(lap(), timeline, [loop(null)])).toBe('Build #485, round 2');
  expect(runTitle(lap(), timeline, [])).toBe('Build #485, round 2');
});

test('a run is titled for what it is', () => {
  expect(runTitle(lap(), runTimeline(failedBuild()))).toBe('Build #485, round 2');
  expect(runTitle(lap({ issue_number: null }), [])).toBe('Build');
  expect(runTitle(lap({ workflow_name: 'factory-app-check', pr_number: 421 }), [])).toBe(
    'App check, PR #421',
  );
  expect(runTitle(lap({ workflow_name: 'factory-app-check' }), [])).toBe('App check');
  expect(runTitle(lap({ workflow_name: 'archon-merge-queue' }), [])).toBe('Merge sweep');
  expect(runTitle(lap({ workflow_name: 'archon-loop', issue_number: 3 }), [])).toBe('Lap #3');
  expect(
    runTitle(lap({ workflow_name: 'archon-intake', issue_number: null, pr_number: 7 }), []),
  ).toBe('Intake, PR #7');
});

const text = (read: ReturnType<typeof managerRead>) => read.parts.map((p) => p.text).join('');

test("the manager's read of a failure names the step, the resume and whether it is code", () => {
  const rows = failedBuild();
  const timeline = runTimeline(rows);
  const stopped = lap({
    stop_step: `${GROUP}.pr__prepare`,
    stop_line: 'boom',
    stop_class: 'environment',
    capacity_since: null,
  });
  const read = managerRead(stopped, rows, timeline);
  expect(text(read)).toBe(
    'pr__prepare failed on round 2: boom. Everything before it succeeded. Resume re-runs pr__prepare and what follows, for about $2.25. This is not a code failure: the environment refused it.',
  );
  expect(read).toMatchObject({ codeFailure: 'no', resumeStep: 'pr__prepare', resumeCost: 2.25 });
  const priced = [step('build', { status: 'failed', cost_usd: '0.4' })];
  expect(text(managerRead(stopped, priced, runTimeline(priced)))).toContain(
    ' Resume re-runs build and what follows. This',
  );
  expect(text(managerRead({ ...stopped, stop_class: 'code' }, rows, timeline))).toEndWith(
    ' This is a code failure.',
  );
  const unknown = managerRead({ ...stopped, stop_class: null }, rows, timeline);
  expect(unknown.codeFailure).toBe('unknown');
  expect(text(unknown)).toEndWith('its error matches no known cause.');
  // No stop record yet: the failed attempt's own first error line stands in.
  expect(text(managerRead(lap(), rows, timeline))).toStartWith(
    'pr__prepare failed on round 2: boom.',
  );
});

test('a paused, finished, cancelled or running run is read in one sentence', () => {
  const rows = [step('ask', { status: 'running' })];
  const read = (over: Partial<OneLapRow>) => text(managerRead(lap(over), rows, runTimeline(rows)));
  expect(read({ status: 'paused', stop_step: 'ask', stop_line: 'Pick one' })).toBe(
    'ask is waiting on you: Pick one.',
  );
  expect(read({ status: 'completed' })).toBe('It finished.');
  expect(read({ status: 'cancelled' })).toBe('It was cancelled.');
  expect(read({ status: 'running' })).toBe('It is running ask now.');
});

test('an answered run waiting for a slot is not read as waiting on you', () => {
  const rows = [step('ask', { status: 'running' })];
  const waiting = lap({
    status: 'paused',
    stop_step: 'ask',
    stop_line: 'Pick one',
    capacity_since: new Date('2026-10-24T09:30:00Z'),
  });
  expect(text(managerRead(waiting, rows, runTimeline(rows)))).toBe(
    'It has your answer and is waiting for a free slot to continue.',
  );
});

test('a paused run reads the question, not its bold title markdown', () => {
  const rows = [step('ask', { status: 'running' })];
  const stop_line = '**Build queue, issue 15: scope decision**';
  const read = managerRead(
    lap({ status: 'paused', stop_step: 'ask', stop_line }),
    rows,
    runTimeline(rows),
  );
  expect(text(read)).toBe('ask is waiting on you: Build queue, issue 15: scope decision.');
});

test('a pending run reads as not started, not as running', () => {
  const read = text(managerRead(lap({ status: 'pending' }), [], runTimeline([])));
  expect(read).toBe('It has not started yet.');
  expect(read).not.toBe('It is running.');
});

test('a failed run with no failed step does not claim a step failed', () => {
  const read = text(managerRead(lap({ status: 'failed', stop_step: null }), [], runTimeline([])));
  expect(read).toStartWith('The run failed.');
  expect(read).not.toContain('Everything before it succeeded');
});
