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

test.each([
  ['lap-hours per merge, lower, over at least 12 laps.', 12],
  ['complex-route lap-hours per merge over 10 laps.', 10],
  ['send-backs per merge, 10 complex laps.', 10],
  ['send-backs per merge, at least 10 laps.', 10],
  ['lap-hours per merge, over 12 laps or more.', 12],
  ['send-backs per merge, over at least 10 complex laps.', 10],
  ['at least 2 merges per hour over 12 laps.', 12],
  ['over 12 laps, at least 2 merges per hour.', 12],
  ['over 10 COMPLEX-ROUTE\tLAPS.', 10],
])('a Measure names its lap count: %s', (measure, wanted) => {
  expect(lapsWanted(measure)).toBe(wanted);
  expect(ledger([pin({ measure, laps: 3 })]).testing[0].waiting).toBe(wanted - 3);
});

test.each([
  null,
  '',
  'fewer send-backs per merge.',
  'at least 2 merges per hour.',
  '2 merges per hour over several laps.',
])('a Measure without a lap count names none: %s', (measure) => {
  expect(lapsWanted(measure)).toBeNull();
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
    pin({ pin_sha: 'g', measure: 'at least 2 merges per hour.', laps: 3 }),
    pin({ pin_sha: 'h', measure: '2 merges per hour over several laps.', laps: 3 }),
  ]);
  expect(testing.map((t) => [t.pin, t.laps, t.waiting])).toEqual([
    ['b', 7, 5],
    ['c', 15, 0],
    ['d', 3, 7],
    ['g', 3, NOT_RECORDED],
    ['h', 3, NOT_RECORDED],
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
