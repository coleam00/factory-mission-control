import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import type { HealthRunRow, HealthStepRow, HealthWorkableRow } from '../lib/health';
import { Failures, OverdueList, WaitingList, Workable } from './Health';

const NOW = Date.parse('2026-10-27T12:00:00Z');
const MINUTE = 60_000;
const render = (node: React.ReactNode) => renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>);

const run = (overrides: Partial<HealthRunRow>): HealthRunRow => ({
  run_id: '5eed0003-0000-4000-8000-00000000000c',
  workflow_name: 'archon-loop',
  status: 'failed',
  started_at: null,
  completed_at: null,
  failed_step: null,
  error: null,
  failed_at: null,
  console: 'http://archon.test',
  ...overrides,
});

test('pending and paused runs show their wait by the browser clock and open their lap', () => {
  const html = render(
    <WaitingList
      rows={[
        run({ status: 'paused', started_at: new Date('2026-10-23T15:00:00Z') }),
        run({ run_id: 'q', status: 'pending', started_at: new Date('2026-10-27T11:55:00Z') }),
      ]}
      factory="mission-control"
      now={NOW}
    />,
  );
  expect(html.indexOf('data-status="pending"')).toBeLessThan(html.indexOf('data-status="paused"'));
  expect(html).toMatch(/data-waited="true"[^>]*>5m</);
  expect(html).toMatch(/data-waited="true"[^>]*>3d 21h</);
  expect(html).toContain('href="/f/mission-control/runs/5eed0003-0000-4000-8000-00000000000c"');
});

test('a paused run of another workflow has no lap page to open', () => {
  const html = render(
    <WaitingList
      rows={[
        run({ workflow_name: 'archon-build-queue', status: 'paused', started_at: new Date(NOW) }),
      ]}
      factory="mission-control"
      now={NOW}
    />,
  );
  expect(html).not.toContain('data-lap-link');
  expect(html).toContain('archon-build-queue');
});

test('a failed run of another workflow has no lap page to open', () => {
  const html = render(
    <Failures
      rows={[run({ run_id: 'q', workflow_name: 'archon-build-queue', failed_step: 'build' })]}
      factory="mission-control"
    />,
  );
  expect(html).not.toContain('data-lap-link');
  expect(html).toContain('data-failed-lap="q"');
});

test('failed laps show a count per cause, every cause even at zero, and each lap with its error', () => {
  const html = render(
    <Failures
      rows={[
        run({ run_id: 'a', failed_step: 'build', error: 'HTTP 429', failed_at: new Date(NOW) }),
        run({ run_id: 'b', failed_step: 'ship__intel', error: 'fetch failed' }),
      ]}
      factory="mission-control"
    />,
  );
  for (const [cause, count] of [
    ['usage-limit', 1],
    ['authentication', 0],
    ['infrastructure', 1],
    ['other', 0],
  ]) {
    expect(html).toContain(`data-cause="${cause}" data-count="${count}"`);
  }
  expect(html).toContain('data-failed-lap="a" data-cause="usage-limit"');
  expect(html).toContain('ship / intel');
  expect(html).toContain('HTTP 429');
});

test('an overdue step shows how long it has run against its p90', () => {
  const completion = (i: number): HealthStepRow => ({
    kind: 'completion',
    run_id: `r${i}`,
    workflow_name: 'archon-loop',
    step_id: 'build',
    at: new Date(NOW - i * 60 * MINUTE),
    duration_ms: 20 * MINUTE,
    console: null,
  });
  const html = render(
    <OverdueList
      rows={[
        completion(1),
        completion(2),
        {
          kind: 'running',
          run_id: 'live',
          workflow_name: 'archon-loop',
          step_id: 'build',
          at: new Date(NOW - 41 * MINUTE),
          duration_ms: null,
          console: null,
        },
      ]}
      factory="mission-control"
      now={NOW}
    />,
  );
  expect(html).toContain('data-overdue-step="build" data-run="live"');
  expect(html).toContain('data-running-for="true">0:41:00<');
  expect(html).toContain('data-p90="true">0:20:00<');
});

test('an overdue step of another workflow has no lap page to open', () => {
  const step = (kind: 'completion' | 'running', run_id: string, at: Date): HealthStepRow => ({
    kind,
    run_id,
    workflow_name: 'archon-build-queue',
    step_id: 'build',
    at,
    duration_ms: kind === 'completion' ? 20 * MINUTE : null,
    console: null,
  });
  const html = render(
    <OverdueList
      rows={[
        step('completion', 'r1', new Date(NOW - 60 * MINUTE)),
        step('completion', 'r2', new Date(NOW - 120 * MINUTE)),
        step('running', 'live', new Date(NOW - 41 * MINUTE)),
      ]}
      factory="mission-control"
      now={NOW}
    />,
  );
  expect(html).toContain('data-overdue-step="build" data-run="live"');
  expect(html).not.toContain('data-lap-link');
});

test('workable issues are counted against running laps, each linking to GitHub', () => {
  const rows: HealthWorkableRow[] = [
    {
      kind: 'issue',
      issue_number: 9,
      title: 'Triggers',
      url: 'https://github.com/o/r/issues/9',
      run_id: null,
    },
    { kind: 'lap', issue_number: null, title: null, url: null, run_id: 'a' },
    { kind: 'lap', issue_number: null, title: null, url: null, run_id: 'b' },
  ];
  const html = render(<Workable rows={rows} />);
  expect(html).toContain('data-tally="workable" data-count="1"');
  expect(html).toContain('data-tally="running" data-count="2"');
  expect(html).toContain('href="https://github.com/o/r/issues/9"');
});
