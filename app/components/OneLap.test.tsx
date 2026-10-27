import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { createMemoryRouter, RouterProvider } from 'react-router';
import type { CheckLineRow, OneLapRow, StepAttemptRow } from '../lib/one-lap';
import { CheckList, LapHeaderBody, StepList } from './OneLap';

function render(element: React.ReactElement): string {
  const router = createMemoryRouter([{ path: '/', element }]);
  return renderToStaticMarkup(<RouterProvider router={router} />);
}

const RUN = '5eed0001-0000-4000-8000-000000000003';
const REASON = 'it changes .claude/settings.json, which only the owner changes';

const refused: OneLapRow = {
  run_id: RUN,
  status: 'completed',
  started_at: new Date('2026-10-01T14:00:00Z'),
  completed_at: new Date('2026-10-01T15:00:00Z'),
  repository: 'coleam00/factory-mission-control',
  console: 'http://localhost:3090',
  issue_number: 3,
  issue_title: 'A migrations runner that refuses main',
  issue_url: 'https://github.com/coleam00/factory-mission-control/issues/3',
  route: 'simple',
  depth: 'normal',
  pr: '#103',
  review_status: 'completed',
  review_outcome: 'merge',
  review_delivers: 'all',
  dispositions: [
    { line: 'B1', action: 'fixed' },
    { line: null, action: 'declined' },
  ],
  gate_status: 'completed',
  gate_outcome: 'refused',
  gate_reason: REASON,
};

const step = (over: Partial<StepAttemptRow>): StepAttemptRow => ({
  step_id: 'review',
  status: 'completed',
  started_at: new Date('2026-10-25T12:00:00Z'),
  duration_ms: 184_250,
  model: null,
  tokens_input: null,
  tokens_output: null,
  tokens_cache_read: null,
  tokens_cache_write: null,
  cost_usd: '0.4213',
  outcome: 'merge',
  error: null,
  ...over,
});

test('the header links the console run, the pull request and the issue, and says why the gate refused', () => {
  const html = render(<LapHeaderBody lap={refused} now={0} />);
  expect(html).toContain(`href="http://localhost:3090/console/r/${RUN}"`);
  expect(html).toContain('href="https://github.com/coleam00/factory-mission-control/pull/103"');
  expect(html).toContain('href="https://github.com/coleam00/factory-mission-control/issues/3"');
  expect(html).toContain('data-outcome="gate-refused"');
  expect(html).toContain('Gate refused');
  expect(html).toContain('data-gate-outcome="refused"');
  expect(html).toContain(REASON);
  expect(html).toContain('data-review-outcome="merge"');
  expect(html).toContain('<span style="color:var(--success)">merge</span>');
  expect(html).toContain('<span style="color:var(--error)">refused</span>');
  expect(html).toContain('data-line="B1"');
  expect(html).toContain('no line id');
  expect(html).toContain('1:00:00');
});

test('the pull request a step names by URL links as its number', () => {
  const html = render(
    <LapHeaderBody
      lap={{ ...refused, pr: 'https://github.com/coleam00/factory-mission-control/pull/103' }}
      now={0}
    />,
  );
  expect(html).toContain('href="https://github.com/coleam00/factory-mission-control/pull/103"');
  expect(html).toContain('data-pr="103"');
  expect(html).toContain('>#103</a>');
});

test('a lap with no review or gate yet says so', () => {
  const html = render(
    <LapHeaderBody
      lap={{
        ...refused,
        status: 'running',
        completed_at: null,
        pr: null,
        review_status: null,
        review_outcome: null,
        review_delivers: null,
        dispositions: null,
        gate_status: null,
        gate_outcome: null,
        gate_reason: null,
      }}
      now={Date.parse('2026-10-01T14:10:00Z')}
    />,
  );
  expect(html).toContain('The review has not run.');
  expect(html).toContain('The merge gate has not run.');
  expect(html).toContain('Running');
  expect(html).toContain('0:10:00');
  expect(html).not.toContain('data-link="pr"');
});

test('both attempts of a repeated review show, the running one with its time so far', () => {
  const html = render(
    <StepList
      rows={[
        step({}),
        step({
          status: 'running',
          started_at: new Date('2026-10-25T13:00:00Z'),
          duration_ms: null,
          model: 'sonnet',
          cost_usd: null,
          outcome: null,
        }),
      ]}
      now={Date.parse('2026-10-25T13:01:30Z')}
    />,
  );
  expect(html.match(/data-step-attempt=/g)).toHaveLength(2);
  expect(html).toContain('data-started="2026-10-25T12:00:00.000Z"');
  expect(html).toContain('data-started="2026-10-25T13:00:00.000Z"');
  expect(html).toContain('0:03:04');
  expect(html).toContain('0:01:30');
  expect(html).toContain('data-lap-cost="0.4213"');
});

test('token counts Realtime sends as strings still group their thousands', () => {
  const html = render(
    <StepList
      rows={[
        step({
          model: 'sonnet',
          tokens_input: '48210',
          tokens_output: '6904',
          tokens_cache_read: '39877',
          tokens_cache_write: '8333',
        }),
      ]}
      now={0}
    />,
  );
  expect(html).toContain('48,210 / 6,904');
  expect(html).toContain('cache read 39,877, cache write 8,333');
});

test('a holdout line shows only its scenario id beside its kind, verdict and evidence', () => {
  const lines: CheckLineRow[] = [
    { position: 1, kind: 'criterion', verdict: 'PASS', evidence_count: 2, scenario_id: null },
    { position: 3, kind: 'holdout', verdict: 'FAIL', evidence_count: 1, scenario_id: 'H-01' },
  ];
  const html = render(<CheckList rows={lines} />);
  expect(html).toContain('data-scenario="H-01"');
  expect(html).toContain('>H-01<');
  expect(html).toContain('data-verdict="FAIL"');
  expect(html).toContain('data-evidence="2"');
});
