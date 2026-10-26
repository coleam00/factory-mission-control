import { expect, test } from 'bun:test';
import {
  dataValue,
  difference,
  type AttemptRow,
  type LapRow,
  type Measured,
  meaningful,
  type ScorecardRow,
  scorecard,
  versionLaps,
  versionPin,
  type VersionRow,
} from './scorecard';

const V = 'sha256:a1';

const step = (run: string, step_id: string, over: Partial<AttemptRow> = {}): AttemptRow => ({
  run_id: run,
  step_id,
  duration_ms: null,
  cost_usd: null,
  route: null,
  outcome: null,
  reason: null,
  holdout_catches: 0,
  pin_sha: null,
  ...over,
});

const version = (digest: string, firstRunAt: string, pin: string | null): VersionRow => ({
  run_id: null,
  step_id: null,
  digest,
  first_run_at: new Date(firstRunAt),
  pin_sha: pin,
});

/** One lap's row and its attempts' rows. */
const lap = (
  run: string,
  start: string | null,
  end: string | null,
  steps: AttemptRow[] = [],
  over: Partial<LapRow> = {},
): ScorecardRow[] => [
  {
    run_id: run,
    digest: V,
    workflow_name: 'archon-loop',
    status: 'completed',
    started_at: start === null ? null : new Date(start),
    completed_at: end === null ? null : new Date(end),
    step_id: null,
    pin_sha: null,
    ...over,
  },
  ...steps.map((r) => ({ ...r, run_id: run })),
];

const card = (rows: ScorecardRow[]) => scorecard(versionLaps(rows, V));

test('each count is the laps its 4.2 definition names, and lists them', () => {
  const rows = [
    ...lap('m', '2026-10-01T08:00:00Z', '2026-10-01T09:00:00Z', [
      step('m', 'pick', { route: 'complex' }),
      step('m', 'review', { outcome: 'merge' }),
      step('m', 'land', { outcome: 'merged', reason: 'Merged abc.' }),
    ]),
    ...lap('e', '2026-10-01T08:00:00Z', '2026-10-01T08:10:00Z', [
      step('e', 'pick', { route: 'none' }),
    ]),
    ...lap('f', '2026-10-01T08:00:00Z', '2026-10-01T08:20:00Z', [step('f', 'pick')], {
      status: 'failed',
    }),
    ...lap('s', '2026-10-01T08:00:00Z', '2026-10-01T08:40:00Z', [
      step('s', 'review', { outcome: 'sent-back' }),
    ]),
    ...lap('r', '2026-10-01T08:00:00Z', '2026-10-01T08:50:00Z', [
      step('r', 'land', { outcome: 'refused', reason: 'it changes ci.yml' }),
    ]),
    step('r', 'check-app', { holdout_catches: 2 }),
    step('s', 'check-app', { holdout_catches: 1 }),
  ];
  const s = card(rows);
  expect(s.laps).toEqual({
    value: 5,
    laps: ['e', 'f', 'm', 'r', 's'],
    counted: ['e', 'f', 'm', 'r', 's'],
  });
  expect(s.merges.counted).toEqual(['m']);
  expect(s.empty_laps.counted).toEqual(['e']);
  expect(s.failed_laps.counted).toEqual(['f']);
  expect(s.send_backs.counted).toEqual(['s']);
  expect(s.gate_refusals.counted).toEqual(['r']);
  expect(s.new_holdout_catches).toMatchObject({ value: 3, counted: ['r', 's'] });
  for (const key of [
    'merges',
    'empty_laps',
    'failed_laps',
    'send_backs',
    'gate_refusals',
  ] as const) {
    expect(s[key].value).toBe(1);
    expect(s[key].laps).toHaveLength(5);
  }
  expect(versionLaps(rows, V).find((l) => l.id === 'r')?.refusals).toEqual(['it changes ci.yml']);
});

test('a lap from 09:50 to 10:10 UTC spans two active hours; two laps in one hour count it once', () => {
  expect(card(lap('x', '2026-10-01T09:50:00Z', '2026-10-01T10:10:00Z')).active_hours.value).toBe(2);
  expect(
    card([
      ...lap('x', '2026-10-01T09:05:00Z', '2026-10-01T09:30:00Z'),
      ...lap('y', '2026-10-01T09:20:00Z', '2026-10-01T09:55:00Z'),
    ]).active_hours.value,
  ).toBe(1);
  expect(card(lap('x', '2026-10-01T09:00:00Z', '2026-10-01T10:00:00Z')).active_hours.value).toBe(1);
});

test('with no merge the per-merge measures are n/a, not a division error', () => {
  const s = card(
    lap('x', '2026-10-01T09:00:00Z', '2026-10-01T10:00:00Z', [
      step('x', 'land', { outcome: 'refused', cost_usd: 1.5 }),
    ]),
  );
  expect(s.merges.value).toBe(0);
  expect(s.cost_per_merge.value).toBeNull();
  expect(s.lap_hours_per_merge.value).toBeNull();
  expect(dataValue(s.cost_per_merge.value)).toBe('n/a');
  expect(dataValue(s.lap_hours_per_merge.value)).toBe('n/a');
  expect(s.merges_per_active_hour.value).toBe(0);
});

test('with no active hour merges per active hour and app-check share are n/a', () => {
  const s = card(
    lap('x', '2026-10-01T09:00:00Z', null, [step('x', 'land', { outcome: 'merged' })]),
  );
  expect(s.active_hours.value).toBe(0);
  expect(s.merges_per_active_hour.value).toBeNull();
  expect(s.app_check_share.value).toBeNull();
});

test('an unfinished lap counts and costs, but no time measure rests on it', () => {
  const s = card([
    ...lap('done', '2026-10-01T08:00:00Z', '2026-10-01T09:00:00Z', [
      step('done', 'build', { cost_usd: 2 }),
      step('done', 'land', { outcome: 'merged' }),
    ]),
    ...lap('running', '2026-10-01T08:30:00Z', null, [step('running', 'build', { cost_usd: 1 })]),
    ...lap('pending', null, null),
  ]);
  expect(s.laps.laps).toEqual(['done', 'running', 'pending']);
  expect(s.cost_per_merge).toEqual({ value: 3, laps: ['done', 'running', 'pending'] });
  for (const key of [
    'active_hours',
    'merges_per_active_hour',
    'lap_hours_per_merge',
    'app_check_share',
  ] as const) {
    expect(s[key].laps).toEqual(['done']);
  }
  expect(s.active_hours.value).toBe(1);
});

test('lap-hours per merge and app-check share on known durations, to 4 decimals', () => {
  const s = card([
    ...lap('a', '2026-10-01T08:00:00Z', '2026-10-01T09:00:00Z', [
      step('a', 'check-app', { duration_ms: 1_200_000 }),
      step('a', 'land', { outcome: 'merged' }),
    ]),
    ...lap('b', '2026-10-01T10:00:00Z', '2026-10-01T10:20:00Z', [
      step('b', 'check-app', { duration_ms: 400_000 }),
      step('b', 'land', { outcome: 'merged' }),
    ]),
    ...lap('c', '2026-10-01T11:00:00Z', '2026-10-01T11:40:00Z', [step('c', 'pick')]),
  ]);
  // 2 h of laps over 2 merges; 1 600 000 ms of check-app over 7 200 000 ms of laps.
  expect(s.lap_hours_per_merge.value).toBe(1);
  expect(s.app_check_share.value).toBe(0.2222);
  expect(dataValue(s.app_check_share.value)).toBe('0.2222');
  expect(s.merges_per_active_hour.value).toBe(0.6667);
});

test('a step that ran twice in a lap counts both attempts', () => {
  const s = card(
    lap('x', '2026-10-01T08:00:00Z', '2026-10-01T09:00:00Z', [
      step('x', 'check-app', { duration_ms: 600_000, cost_usd: 1, holdout_catches: 1 }),
      step('x', 'review', { outcome: 'sent-back', cost_usd: 0.5 }),
      step('x', 'build', { cost_usd: 2 }),
      step('x', 'check-app', { duration_ms: 300_000, cost_usd: 1, holdout_catches: 1 }),
      step('x', 'review', { outcome: 'approved', cost_usd: 0.5 }),
      step('x', 'land', { outcome: 'refused', reason: 'the checks failed' }),
      step('x', 'land', { outcome: 'merged' }),
    ]),
  );
  expect(s.send_backs).toMatchObject({ value: 1, counted: ['x'] });
  expect(s.merges.value).toBe(1);
  expect(s.gate_refusals.value).toBe(1);
  // 900 000 ms of check-app over a 3 600 000 ms lap; $5 over every attempt of every step.
  expect(s.app_check_share.value).toBe(0.25);
  expect(s.cost_per_merge.value).toBe(5);
  expect(s.new_holdout_catches).toMatchObject({ value: 2, counted: ['x'] });
});

test('with merges but no finished lap, lap-hours per merge is n/a, not 0', () => {
  const s = card(
    lap('x', '2026-10-01T09:00:00Z', null, [step('x', 'land', { outcome: 'merged' })]),
  );
  expect(s.merges.value).toBe(1);
  expect(s.lap_hours_per_merge).toEqual({ value: null, laps: [] });
  expect(dataValue(s.lap_hours_per_merge.value)).toBe('n/a');
});

test('with no check-app on a finished lap, app-check share is 0, not n/a', () => {
  const s = card([
    ...lap('x', '2026-10-01T09:00:00Z', '2026-10-01T10:00:00Z', [step('x', 'build')]),
    ...lap('y', '2026-10-01T09:00:00Z', null, [step('y', 'check-app', { duration_ms: 60_000 })]),
  ]);
  expect(s.app_check_share).toEqual({ value: 0, laps: ['x'] });
  expect(dataValue(s.app_check_share.value)).toBe('0.0000');
  const timed = card(
    lap('x', '2026-10-01T09:00:00Z', '2026-10-01T10:00:00Z', [
      step('x', 'check-app', { duration_ms: 0 }),
    ]),
  );
  expect(timed.app_check_share.value).toBe(0);
  const none = card(
    lap('y', '2026-10-01T09:00:00Z', null, [step('y', 'check-app', { duration_ms: 60_000 })]),
  );
  expect(none.app_check_share).toEqual({ value: null, laps: [] });
});

test('a run of another workflow is not a lap', () => {
  const s = card([
    ...lap('loop', '2026-10-01T08:00:00Z', '2026-10-01T09:00:00Z'),
    ...lap('manager', '2026-10-01T08:00:00Z', '2026-10-01T09:00:00Z', [], {
      workflow_name: 'archon-manager',
    }),
  ]);
  expect(s.laps.laps).toEqual(['loop']);
});

test('a version is labelled by its version row, and a digest with no row is not a version', () => {
  const laps: ScorecardRow[] = [
    ...lap('loop', '2026-10-05T08:00:00Z', '2026-10-05T09:00:00Z'),
    ...lap('manager', '2026-10-03T08:00:00Z', null, [step('manager', 'plan', { cost_usd: 1 })], {
      workflow_name: 'archon-manager',
      digest: 'sha256:manager-only',
    }),
  ];
  expect(versionPin([...laps, version(V, '2026-10-05T08:00:00Z', 'before')], V)).toEqual({
    firstRunAt: new Date('2026-10-05T08:00:00Z'),
    pin: 'before',
  });
  expect(versionPin([...laps, version(V, '2026-10-05T08:00:00Z', null)], V)).toEqual({
    firstRunAt: new Date('2026-10-05T08:00:00Z'),
    pin: null,
  });
  expect(versionPin(laps, 'sha256:manager-only')).toEqual({ firstRunAt: null, pin: null });
});

test("another version's rows are ignored", () => {
  const s = card([
    ...lap('mine', '2026-10-01T08:00:00Z', '2026-10-01T09:00:00Z'),
    ...lap(
      'theirs',
      '2026-10-01T08:00:00Z',
      '2026-10-01T09:00:00Z',
      [step('theirs', 'land', { outcome: 'merged' })],
      { digest: 'sha256:b2' },
    ),
  ]);
  expect(s.laps.laps).toEqual(['mine']);
  expect(s.merges.value).toBe(0);
});

test('a difference is meaningful only when both sides rest on 10 laps or more', () => {
  const on = (n: number, value: number | null): Measured => ({
    value,
    laps: Array.from({ length: n }, (_, i) => `lap-${i}`),
  });
  expect(meaningful(on(10, 1), on(10, 2))).toBe(true);
  expect(meaningful(on(9, 1), on(10, 2))).toBe(false);
  expect(meaningful(on(10, 1), on(9, 2))).toBe(false);
  expect(difference(on(10, 0.2), on(10, 0.2857))).toBe(0.0857);
  expect(difference(on(10, 7.6), on(10, 4.5))).toBe(-3.1);
  expect(difference(on(10, null), on(10, 4.5))).toBeNull();
  expect(difference(on(10, 1), on(10, null))).toBeNull();
});
