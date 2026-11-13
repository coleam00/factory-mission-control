import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import type { FailureGroupRow, RetriedRunRow } from '../lib/failures';
import { FailuresBody } from './Failures';

const NOW = Date.parse('2026-10-24T12:00:00Z');
const RUN = '5eed0005-0000-4000-8000-000000000001';

const group = (overrides: Partial<FailureGroupRow> = {}): FailureGroupRow => ({
  signature: 'sig',
  workflow_name: 'archon-loop',
  step_id: 'review',
  class: 'code',
  failures: 2,
  first_at: new Date('2026-10-23T10:00:00Z'),
  last_at: new Date('2026-10-24T10:00:00Z'),
  latest_run_id: RUN,
  line: 'boom',
  last_day: new Date('2026-10-24'),
  daily: [0, 1, 1],
  console: 'http://localhost:3090/',
  ...overrides,
});

const retried: RetriedRunRow = {
  run_id: '5eed0000-0000-4000-8000-000000000009',
  workflow_name: 'archon-merge-queue',
  step_id: 'facts',
  line: "Couldn't connect to compute node",
  stopped_at: new Date(NOW - 60_000),
};

const draw = (groups: FailureGroupRow[], rows: RetriedRunRow[] = []) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <FailuresBody factory="f" groups={groups} retried={{ rows, state: 'ready' }} now={NOW} />
    </MemoryRouter>,
  );

test('a failure card says its runs and age in words, with no sparkline and one muted error line', () => {
  const html = draw([group()]);
  expect(html).toContain('2 runs, last 2h 0m ago');
  expect(html).toContain('code');
  expect(html).toContain(`href="/f/f/runs/${RUN}`);
  expect(html).not.toContain('Failures per day');
  expect(html).toMatch(/<p[^>]*data-error[^>]*truncate[^>]*>boom<\/p>/);
  expect(html).not.toContain('role="img"');
});

test('the folded transient line closes the list, and an empty view says so', () => {
  const html = draw([group()], [retried]);
  expect(html.indexOf('data-retried')).toBeGreaterThan(html.indexOf('data-failure='));
  expect(html).toContain('1 run hit a passing database or GitHub error today and was retried.');
  expect(draw([])).toContain('No unresolved failures.');
});
