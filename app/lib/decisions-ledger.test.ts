import { expect, test } from 'bun:test';
import {
  type LedgerRow,
  lapsWanted,
  ledger,
  type TimelineRow,
  timelineEntries,
} from './decisions-ledger';
import { NOT_RECORDED } from './version-strip';

const decision = (date: string, title: string): TimelineRow => ({
  date,
  title,
  decision: 'd',
  why: 'w',
  replaces: 'r',
  version: 'none',
  pin_sha: null,
  digest: null,
});

test('the timeline is in date order, ties by title', () => {
  const rows = [
    decision('2026-10-15', 'Run three laps at once'),
    decision('2026-09-30', 'Fence the holdouts'),
    decision('2026-10-15', 'A second decision that day'),
  ];
  expect(timelineEntries(rows).map((r) => r.title)).toEqual([
    'Fence the holdouts',
    'A second decision that day',
    'Run three laps at once',
  ]);
});

test('a Measure names its lap count by "at least <n>", or names none', () => {
  expect(lapsWanted('lap-hours per merge, lower, over at least 12 laps.')).toBe(12);
  expect(lapsWanted('send-backs per merge, over at least 10 complex laps.')).toBe(10);
  expect(lapsWanted('complex-route lap-hours per merge over 10 laps.')).toBeNull();
  expect(lapsWanted(null)).toBeNull();
});

const pin = (over: Partial<LedgerRow>): LedgerRow => ({
  pin_sha: '0'.repeat(40),
  reason: 'a reason',
  measure: null,
  committed_at: new Date('2026-10-01T00:00:00Z'),
  laps: 0,
  verdict: null,
  sentence: null,
  verdict_at: null,
  ...over,
});

test('a pin with a Measure and no verdict is being tested, waiting for the laps it still needs', () => {
  const { testing, verdicts } = ledger([
    pin({ pin_sha: 'b', measure: 'over at least 12 laps.', laps: 7 }),
    pin({ pin_sha: 'c', measure: 'over at least 12 laps.', laps: 15 }),
    pin({ pin_sha: 'd', measure: 'over 10 laps.', laps: 3 }),
    pin({ pin_sha: 'e', measure: '  ' }),
    pin({ pin_sha: 'f' }),
  ]);
  expect(testing.map((t) => [t.pin, t.laps, t.waiting])).toEqual([
    ['b', 7, 5],
    ['c', 15, 0],
    ['d', 3, NOT_RECORDED],
  ]);
  expect(verdicts).toEqual([]);
});

test('a pin with a verdict leaves being tested and shows its verdict and sentence, Measure or not', () => {
  const { testing, verdicts } = ledger([
    pin({
      pin_sha: 'a',
      measure: 'over at least 10 laps.',
      verdict: 'helped',
      sentence: 'faster.',
      verdict_at: new Date('2026-10-09T17:00:00Z'),
    }),
    pin({
      pin_sha: 'c',
      verdict: 'inconclusive',
      sentence: 'too few laps.',
      verdict_at: new Date('2026-10-02T00:00:00Z'),
    }),
  ]);
  expect(testing).toEqual([]);
  expect(verdicts.map((v) => [v.pin, v.verdict, v.sentence, v.date])).toEqual([
    ['c', 'inconclusive', 'too few laps.', '2026-10-02'],
    ['a', 'helped', 'faster.', '2026-10-09'],
  ]);
});
