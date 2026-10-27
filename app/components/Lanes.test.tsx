import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { type LaneRow, OUTCOME_LABEL, OUTCOMES, type RecentLapRow } from '../lib/laps';
import { LaneList, RecentList } from './Lanes';

function render(element: React.ReactElement): string {
  const router = createMemoryRouter([{ path: '/', element }]);
  return renderToStaticMarkup(<RouterProvider router={router} />);
}

const RUN = '5eed0003-0000-4000-8000-00000000000a';

const lane = (over: Partial<LaneRow>): LaneRow => ({
  run_id: RUN,
  started_at: new Date('2026-10-21T09:00:00Z'),
  issue_number: 11,
  issue_title: 'Show the scorecard',
  issue_url: 'https://github.com/coleam00/factory-mission-control/issues/11',
  route: 'simple',
  depth: 'normal',
  step_id: 'ship__intel',
  step_started_at: new Date('2026-10-21T09:04:00Z'),
  cost_usd: '1.3',
  ...over,
});

test('a lane shows its issue, route, depth, step, time on the step and cost so far', () => {
  const html = render(<LaneList rows={[lane({})]} now={Date.parse('2026-10-22T10:05:30Z')} />);
  expect(html).toContain(`data-lane="${RUN}"`);
  expect(html).toContain('data-step="ship__intel"');
  expect(html).toContain('data-cost="1.3"');
  expect(html).toContain('href="https://github.com/coleam00/factory-mission-control/issues/11"');
  expect(html).toContain('>#11<');
  expect(html).toContain('ship / intel');
  expect(html).toContain('1d 1:01:30');
  expect(html).toContain('$1.30');
});

test('a lane before its pick and claim says so instead of guessing', () => {
  const html = render(
    <LaneList
      rows={[
        lane({
          issue_number: null,
          issue_title: null,
          issue_url: null,
          route: null,
          depth: null,
          step_id: null,
          step_started_at: null,
          cost_usd: null,
        }),
      ]}
      now={0}
    />,
  );
  expect(html).toContain('No issue claimed yet');
  expect(html).toContain('not started');
  expect(html).toContain('not recorded');
  expect(html).toContain('$0.00');
});

test('lanes and recent laps share hours and trimmed sub-dollar costs', () => {
  const started = new Date('2026-10-21T09:00:00Z');
  const completed = new Date('2026-10-21T09:20:00Z');
  const running = render(
    <LaneList
      rows={[lane({ step_started_at: started, cost_usd: '0.1' })]}
      now={completed.getTime()}
    />,
  );
  const finished = render(
    <RecentList
      factory="mission-control"
      rows={[
        {
          run_id: RUN,
          status: 'completed',
          started_at: started,
          completed_at: completed,
          issue_number: 11,
          outcome: 'merged',
          cost_usd: '0.1',
        },
      ]}
    />,
  );
  for (const html of [running, finished]) {
    expect(html).toContain('>0:20:00<');
    expect(html).toContain('>$0.10<');
  }
});

test('every outcome is labelled and links its lap; a lap with none says its status', () => {
  const rows: RecentLapRow[] = [...OUTCOMES, null].map((outcome, i) => ({
    run_id: `5eed0001-0000-4000-8000-00000000000${i}`,
    status: outcome === null ? 'cancelled' : 'completed',
    started_at: new Date(`2026-10-0${i + 1}T08:00:00Z`),
    completed_at: new Date(`2026-10-0${i + 1}T09:30:00Z`),
    issue_number: i,
    outcome,
    cost_usd: 2,
  }));
  const html = render(<RecentList rows={rows} factory="mission-control" />);
  for (const outcome of OUTCOMES) {
    expect(html).toContain(`data-outcome="${outcome}"`);
    expect(html).toContain(OUTCOME_LABEL[outcome]);
  }
  expect(html).toContain('No outcome, cancelled');
  expect(html).toContain('href="/f/mission-control/laps/5eed0001-0000-4000-8000-000000000000"');
  expect(html).toContain('1:30:00');
  expect(html).toContain('ended 2026-10-01 09:30 UTC');
});
