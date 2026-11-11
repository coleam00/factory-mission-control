import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { FactoryScorecardRow } from '../lib/factory-scorecard';
import { FactoryScorecardBody } from './FactoryScorecard';

const row = (name: string, over: Partial<FactoryScorecardRow> = {}): FactoryScorecardRow => ({
  name,
  kind: 'score',
  unit: 'ratio',
  value_7: 0.9286,
  n_7: 14,
  value_7_before: 0.9167,
  n_7_before: 12,
  value_30: 0.8929,
  n_30: 56,
  value_30_before: 0.9,
  n_30_before: 50,
  ...over,
});

const ROWS = [
  row('sdlc.pr_merge_rate'),
  row('sdlc.issues_merged', { kind: 'count', value_7: 14, value_30: 56 }),
  row('sdlc.issues_merged.investigate', {
    kind: 'count',
    value_7: 2,
    n_7: 2,
    value_7_before: null,
    n_7_before: 0,
    value_30: 2,
    n_30: 2,
    value_30_before: null,
    n_30_before: 0,
  }),
  row('sdlc.test_lines_added', {
    kind: 'count',
    value_7: 75,
    n_7: 6,
    value_7_before: 130,
    n_7_before: 5,
  }),
];

const render = (
  rows: FactoryScorecardRow[] | undefined,
  state: 'loading' | 'ready' | 'error',
  window: '7' | '30' = '7',
) =>
  renderToStaticMarkup(
    <FactoryScorecardBody rows={rows} state={state} window={window} onWindow={() => {}} />,
  );

test('the 7-day view shows each value with its sample size beside the period before', () => {
  const html = render(ROWS, 'ready');
  expect(html).toContain('PR merge rate');
  expect(html).toContain('92.9%');
  expect(html).toContain('91.7%');
  expect(html).toContain('+1.2 pts');
  expect(html).toContain('n 14');
  expect(html).toContain('n 12');
  expect(html).toContain('aria-pressed="true"');
});

test('the 30-day view shows the 30-day columns', () => {
  const html = render(ROWS, 'ready', '30');
  expect(html).toContain('89.3%');
  expect(html).toContain('n 56');
  expect(html).toContain('-0.7 pts');
});

test('a route with too few records and the lines say so instead of a change', () => {
  const html = render(ROWS, 'ready');
  expect(html).toContain('investigate');
  // The route, the lines, and the 7-day columns that have no row at all.
  expect(html.match(/Too few to compare/g)?.length).toBeGreaterThanOrEqual(2);
  expect(html).not.toContain('+-');
});

test('no rows, loading and an error are each one sentence', () => {
  expect(render([], 'ready')).toContain(
    'No metric records yet: Archon writes them when archon-metrics-prs runs.',
  );
  expect(render(undefined, 'loading')).toContain('Loading the scorecard.');
  expect(render(undefined, 'error')).toContain('Live data is unavailable.');
});
