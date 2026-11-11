import { expect, test } from 'bun:test';
import {
  type FactoryScorecardRow,
  formatChange,
  formatValue,
  msToUtcMidnight,
  scorecardMeasures,
  scorecardUntil,
} from './factory-scorecard';

const row = (name: string, over: Partial<FactoryScorecardRow> = {}): FactoryScorecardRow => ({
  name,
  kind: 'score',
  unit: 'rounds',
  value_7: 3,
  n_7: 10,
  value_7_before: 2,
  n_7_before: 10,
  value_30: 3,
  n_30: 40,
  value_30_before: 2.5,
  n_30_before: 40,
  ...over,
});

const rounds = (rows: FactoryScorecardRow[], window: '7' | '30' = '7') =>
  scorecardMeasures(rows, window).find((m) => m.name === 'sdlc.review_rounds');

test('a comparison needs 10 records on each side: 9 on either side is too few, 10 on both is not', () => {
  expect(rounds([row('sdlc.review_rounds')])).toMatchObject({ tooFew: false, change: 1 });
  expect(rounds([row('sdlc.review_rounds', { n_7: 9 })])).toMatchObject({
    tooFew: true,
    change: null,
  });
  expect(rounds([row('sdlc.review_rounds', { n_7_before: 9 })])).toMatchObject({
    tooFew: true,
    change: null,
  });
});

test('the 30-day window reads the 30-day columns', () => {
  expect(rounds([row('sdlc.review_rounds')], '30')).toMatchObject({
    now: 3,
    before: 2.5,
    nNow: 40,
    nBefore: 40,
    change: 0.5,
  });
});

test('the change is signed and in the measure’s unit: points for ratios, hours, a plain number', () => {
  expect(formatChange('percent', 0.0119)).toBe('+1.2 pts');
  expect(formatChange('whole-percent', -0.03)).toBe('-3 pts');
  expect(formatChange('hours', 0.34)).toBe('+0.3 h');
  expect(formatChange('decimal', -1)).toBe('-1.0');
  expect(formatChange('count', 4)).toBe('+4');
  expect(formatChange('count', 0)).toBe('0');
});

test('a value reads in its format, and a score with no records is a dash while a count is zero', () => {
  expect(formatValue('percent', 0.993)).toBe('99.3%');
  expect(formatValue('whole-percent', 0.29)).toBe('29%');
  expect(formatValue('hours', 11.2)).toBe('11 h');
  expect(formatValue('hours', 7.71)).toBe('7.7 h');
  const none = scorecardMeasures([], '7');
  expect(none.find((m) => m.name === 'sdlc.issues_merged')).toMatchObject({
    now: 0,
    nNow: 0,
    tooFew: true,
  });
  expect(none.find((m) => m.name === 'sdlc.review_rounds')).toMatchObject({ now: null, nNow: 0 });
  expect(formatValue('decimal', null)).toBe('-');
});

test('routes nest under their measure by name, and only those with a record in the window show', () => {
  const merged = (route: string, over: Partial<FactoryScorecardRow>) =>
    row(`sdlc.issues_merged.${route}`, { kind: 'count', unit: 'issues', ...over });
  const measures = scorecardMeasures(
    [
      row('sdlc.issues_merged', { kind: 'count' }),
      merged('plan', {}),
      merged('deliver', {}),
      merged('continue', { n_7: 0, n_7_before: 0, value_7: null, value_7_before: null }),
    ],
    '7',
  );
  expect(measures[0]?.name).toBe('sdlc.issues_merged');
  expect(measures[0]?.routeRows.map((r) => r.route)).toEqual(['deliver', 'plan']);
});

test('measures come in the scorecard’s order, one per measure, with or without a row', () => {
  expect(scorecardMeasures([], '7').map((m) => m.label)).toEqual([
    'Issues merged',
    'PR merge rate',
    'Review rounds to Ready',
    'Ready in one round',
    'Needing five rounds or more',
    'Issue lead time',
    'Build rounds per issue',
    'Owner asks per issue',
    'Test lines added',
    'Production lines added',
  ]);
});

test('the windows end at the UTC date after now, and move on at UTC midnight', () => {
  expect(scorecardUntil(new Date('2026-11-11T23:30:00Z'))).toBe('2026-11-12');
  expect(scorecardUntil(new Date('2026-11-12T00:00:00Z'))).toBe('2026-11-13');
  expect(msToUtcMidnight(new Date('2026-11-11T23:30:00Z'))).toBe(30 * 60_000);
  expect(msToUtcMidnight(new Date('2026-11-12T00:00:00Z'))).toBe(86_400_000);
});
