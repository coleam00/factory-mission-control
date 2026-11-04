import { expect, test } from 'bun:test';
import {
  type ChangeItem,
  changeTimeline,
  pairSearch,
  previousDigest,
  resolvePair,
  selectableVersions,
  testingChip,
  togglePair,
} from './changes';
import type { LedgerRow, TimelineRow } from './decisions-ledger';
import type { ScorecardRow } from './scorecard';
import type { VersionStripRow } from './version-strip';

const V1 = `sha256:${'a1'.repeat(32)}`;
const V2 = `sha256:${'b2'.repeat(32)}`;
const V3 = `sha256:${'c3'.repeat(32)}`;
const P1 = '1111111111';
const P2 = '2222222222';
const P3 = '3333333333';
const PENDING = '4444444444';
const at = (day: number) => new Date(Date.UTC(2026, 9, day));

const strip: VersionStripRow[] = [
  {
    digest: V1,
    first_run_at: at(2),
    pin_sha: P1,
    reason: 'one',
    committed_at: at(1),
    hypothesis: null,
    measure: null,
  },
  {
    digest: V2,
    first_run_at: at(12),
    pin_sha: P2,
    reason: 'two',
    committed_at: at(10),
    hypothesis: 'h',
    measure: 'm',
  },
  {
    digest: V3,
    first_run_at: at(22),
    pin_sha: P3,
    reason: 'three',
    committed_at: at(20),
    hypothesis: 'h',
    measure: '10 laps',
  },
  {
    digest: null,
    first_run_at: null,
    pin_sha: PENDING,
    reason: 'pending',
    committed_at: at(25),
    hypothesis: null,
    measure: null,
  },
];

const pinRow = (pin_sha: string, over: Partial<LedgerRow>): LedgerRow => ({
  pin_sha,
  reason: 'r',
  measure: null,
  committed_at: at(1),
  laps: 0,
  verdict: null,
  sentence: null,
  verdict_at: null,
  pin_matches: 1,
  ...over,
});

const ledgerRows: LedgerRow[] = [
  pinRow(P1, { verdict: 'helped', sentence: 'it helped', verdict_at: at(8) }),
  pinRow(P3, { measure: '10 laps', laps: 3 }),
  pinRow('deadbeef', { verdict: 'hurt', sentence: 'lost', verdict_at: at(15), pin_matches: 0 }),
];

const decision = (over: Partial<TimelineRow>): TimelineRow => ({
  date: '2026-10-11',
  title: 'd',
  decision: 'x',
  why: 'y',
  replaces: 'z',
  version: 'v',
  pin_sha: null,
  ambiguous: false,
  digest: null,
  ...over,
});

const summary = (items: ChangeItem[]) =>
  items.map((item) =>
    item.kind === 'version'
      ? `version ${item.entry.pin?.slice(0, 1)}${item.decisions.map((d) => ` +${d.title}`).join('')}`
      : item.kind === 'decision'
        ? `decision ${item.decision.title}`
        : `verdict ${item.verdict.pin}`,
  );

test('versions come newest first, a pending pin at its commit date', () => {
  expect(summary(changeTimeline(strip, [], []))).toEqual([
    'version 4',
    'version 3',
    'version 2',
    'version 1',
  ]);
});

test('a matched decision sits under its digest, or under a pending pin without one', () => {
  const items = changeTimeline(
    strip,
    [],
    [
      decision({ title: 'a', pin_sha: P2, digest: V2 }),
      decision({ title: 'b', pin_sha: PENDING, digest: null }),
    ],
  );
  expect(summary(items)).toEqual(['version 4 +b', 'version 3', 'version 2 +a', 'version 1']);
});

test('unmatched decisions and verdicts get their own row by date', () => {
  const items = changeTimeline(strip, ledgerRows, [
    decision({ title: 'none', date: '2026-10-21' }),
    decision({ title: 'several', date: '2026-10-05', ambiguous: true }),
  ]);
  expect(summary(items)).toEqual([
    'version 4',
    'decision none',
    'version 3',
    'verdict deadbeef',
    'version 2',
    'decision several',
    'version 1',
  ]);
});

test('chips: a verdict on its pin, testing progress, none otherwise', () => {
  const items = changeTimeline(strip, ledgerRows, []).filter((i) => i.kind === 'version');
  const [pending, three, two, one] = items;
  expect(one.kind === 'version' && one.verdict?.verdict).toBe('helped');
  expect(three.kind === 'version' && three.testing?.laps).toBe(3);
  expect(three.kind === 'version' && three.testing?.waiting).toBe(7);
  expect(two.kind === 'version' && [two.verdict, two.testing]).toEqual([null, null]);
  expect(pending.kind === 'version' && [pending.verdict, pending.testing]).toEqual([null, null]);
});

const items = changeTimeline(strip, [], []);
const scorecardRows = (digests: string[]): ScorecardRow[] =>
  digests.map((digest, i) => ({
    run_id: null,
    step_id: null,
    digest,
    first_run_at: at(i + 1),
    pin_sha: null,
  }));
const withLaps = (digest: string, id: string): ScorecardRow => ({
  run_id: id,
  digest,
  workflow_name: 'archon-loop',
  status: 'completed',
  started_at: at(1),
  completed_at: at(1),
  step_id: null,
  pin_sha: null,
});

test('the default pair is the newest version with laps and the one before it', () => {
  const rows = [...scorecardRows([V1, V2, V3]), withLaps(V3, 'r3'), withLaps(V2, 'r2')];
  expect(resolvePair(items, rows, null, null)).toEqual({ a: V2, b: V3, isDefault: true });
  expect(resolvePair(items, undefined, null, null)).toEqual({ isDefault: true });
});

test('a digest with laps but no version row is never the default', () => {
  const ghost = 'sha256:unversioned';
  const rows = [...scorecardRows([V1, V2, V3]), withLaps(ghost, 'rg')];
  expect(resolvePair(items, rows, null, null)).toEqual({ isDefault: true });
});

test('a newer lap digest off the timeline does not hide the default on it', () => {
  const rows = [...scorecardRows([V1, V2, V3]), withLaps(V2, 'r2'), { ...withLaps('sha256:unversioned', 'rg'), started_at: at(9) }];
  expect(resolvePair(items, rows, null, null)).toEqual({ a: V1, b: V2, isDefault: true });
});

test('a pair from the address is sorted, and unknown digests are dropped', () => {
  expect(resolvePair(items, [], V3, V1)).toEqual({ a: V1, b: V3, isDefault: false });
  expect(resolvePair(items, [], 'sha256:nope', V2)).toEqual({ a: V2, isDefault: false });
  const rows = [...scorecardRows([V1]), withLaps(V1, 'r1')];
  expect(resolvePair(items, rows, 'x', 'y')).toEqual({ a: V1, isDefault: true });
});

test('toggling unchecks one, adds a second, and replaces the older of two', () => {
  expect(togglePair(items, { a: V1, b: V2 }, V1)).toEqual({ a: V2 });
  expect(togglePair(items, { a: V1 }, V3)).toEqual({ a: V1, b: V3 });
  expect(togglePair(items, { a: V1, b: V2 }, V3)).toEqual({ a: V2, b: V3 });
  expect(togglePair(items, { a: V1 }, V1)).toEqual({});
});

test('pairSearch sets a and b and keeps the rest', () => {
  const next = pairSearch(new URLSearchParams('a=old&x=1'), { a: V1, b: V2 });
  expect(next.get('x')).toBe('1');
  expect([next.get('a'), next.get('b')]).toEqual([V1, V2]);
  expect(pairSearch(next, {}).toString()).toBe('x=1');
});

test("the testing chip states the Measure's lap count, even once laps pass it", () => {
  const testing = (laps: number, measure: string) =>
    ({ pin: P3, reason: 'r', measure, laps, waiting: Math.max(0, 10 - laps) }) as const;
  expect(testingChip(testing(3, '10 laps'), 'sha256:x')).toBe('testing, 3 of 10 laps');
  expect(testingChip(testing(12, '10 laps'), 'sha256:x')).toBe('testing, 12 of 10 laps');
  expect(testingChip(testing(4, 'merge rate improves'), 'sha256:x')).toBe('testing, 4 laps');
  expect(testingChip(testing(0, '10 laps'), 'sha256:x')).toBe('testing');
  expect(testingChip(testing(0, 'merge rate improves'), 'sha256:x')).toBe('testing');
  expect(testingChip(testing(3, '10 laps'), null)).toBe('testing');
});

test('the previous version is the next older row, none for the oldest or an unknown digest', () => {
  expect(previousDigest(items, V3)).toBe(V2);
  expect(previousDigest(items, V2)).toBe(V1);
  expect(previousDigest(items, V1)).toBeNull();
  expect(previousDigest(items, 'sha256:unknown')).toBeNull();
});

test('only versions that have run are selectable, not pending pins or decisions', () => {
  const oneRun = [strip[0], strip[3]].filter((r): r is VersionStripRow => r !== undefined);
  const items = changeTimeline(oneRun, [], [decision({ title: 'none', date: '2026-10-21' })]);
  expect(items.length).toBeGreaterThan(1);
  expect(selectableVersions(items)).toBe(1);
  expect(selectableVersions(changeTimeline(strip, [], []))).toBe(3);
});
