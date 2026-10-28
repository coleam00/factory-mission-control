import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { createMemoryRouter, RouterProvider } from 'react-router';
import type { CheckLineRow, OneLapRow, StepAttemptRow } from '../lib/one-lap';
import Lap from '../routes/f.$factory.laps.$runId';
import type { LapMapRow } from '../lib/lap-graph';
import { CheckList, isRunId, LapFound, LapHeaderBody, LapStepsBody, StepList } from './OneLap';

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

/** The loop at a pin, cut down: pick, then ship holding intel and outcome, then review. */
const mapRow = (path: string, position: number, over: Partial<LapMapRow> = {}): LapMapRow => {
  const parts = path.split('/');
  return {
    pin: '5ffd60c6c6e591487f2fbb5ec67ccc8fc55ca915',
    path,
    parent_path: parts.length === 1 ? null : parts.slice(0, -1).join('/'),
    position,
    step_id: parts.at(-1) as string,
    kind: 'prompt',
    depends_on: [],
    detail_workflow: 'archon-loop',
    detail_path: path,
    ...over,
  };
};
const map: LapMapRow[] = [
  mapRow('pick', 1),
  mapRow('ship', 2, { kind: 'include', depends_on: ['pick'] }),
  mapRow('ship/intel', 3, { detail_workflow: 'archon-ship-block', detail_path: 'intel' }),
  mapRow('ship/outcome', 4, { depends_on: ['intel'] }),
  mapRow('review', 5, { depends_on: ['ship'] }),
];

test('both attempts of a repeated review show, the running one with its time so far', () => {
  const html = render(
    <LapStepsBody
      map={{ rows: map, state: 'ready' }}
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
  // One node for the step, running, with its time so far; its side panel lists both attempts.
  expect(html).toMatch(/data-graph-step="review" data-step-state="running" data-attempts="2"/);
  expect(html).toContain('data-step-panel="review"');
  expect(html.match(/data-panel-attempt=/g)).toHaveLength(2);
  // Every attempt is still a row, folded away under the graph.
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

test('a lap address that is not a run id shows the id as typed and nothing under it', () => {
  expect(isRunId(RUN)).toBe(true);
  expect(isRunId('not-a-uuid')).toBe(false);
  const router = createMemoryRouter([{ path: '/f/:factory/laps/:runId', element: <Lap /> }], {
    initialEntries: ['/f/mission-control/laps/not-a-uuid'],
  });
  const html = renderToStaticMarkup(<RouterProvider router={router} />);
  expect(html).toContain('not-a-uuid');
  expect(html).toContain('data-no-lap');
  expect(html).not.toContain('data-live');
  expect(html).not.toContain('No step has started yet.');
});

test('a well-formed id with no lap in this factory shows only the not-found line', () => {
  const unknown = '5eed0001-0000-4000-8000-0000000000ff';
  const html = render(
    <LapFound lap={undefined} runId={unknown}>
      <p>No step has started yet.</p>
    </LapFound>,
  );
  expect(html).toContain('data-no-lap');
  expect(html).toContain(unknown);
  expect(html).not.toContain('No step has started yet.');
  expect(html).not.toContain('data-lap=');
  const found = render(
    <LapFound lap={refused} runId={RUN} now={0}>
      <p>No step has started yet.</p>
    </LapFound>,
  );
  expect(found).toContain(`data-lap="${RUN}"`);
  expect(found).toContain('No step has started yet.');
  expect(found).not.toContain('data-no-lap');
});

test('a value the lap never recorded reads in the secondary text, not the tertiary grey', () => {
  const html = render(<StepList rows={[step({ model: null, cost_usd: null })]} now={0} />);
  expect(html).toContain('<span class="text-text-secondary">none</span>');
  expect(html).not.toContain('text-text-tertiary');
});

test('each step of the map is a node marked by what happened to it, inner steps inside their box', () => {
  const at = (minute: number) => new Date(Date.UTC(2026, 9, 25, 12, minute));
  const html = render(
    <LapStepsBody
      map={{ rows: map, state: 'ready' }}
      rows={[
        step({ step_id: 'pick', started_at: at(0), outcome: null }),
        step({ step_id: 'ship__intel', started_at: at(5), outcome: null }),
        step({
          step_id: 'ship__outcome',
          status: 'failed',
          started_at: at(9),
          outcome: null,
          error: 'tests failed',
        }),
      ]}
      now={Date.parse('2026-10-25T13:00:00Z')}
    />,
  );
  const state = (path: string) =>
    html.match(new RegExp(`data-graph-step="${path}" data-step-state="([a-z-]+)"`))?.[1];
  expect(state('pick')).toBe('finished');
  expect(state('ship/intel')).toBe('finished');
  expect(state('ship/outcome')).toBe('failed');
  // Archon sends no event of its own for an include: its box takes what happened inside it.
  expect(state('ship')).toBe('failed');
  expect(state('review')).toBe('not-reached');
  expect(html).toContain('The loop at pin 5ffd60c');
  expect(html).toContain('Click a step to see');
});

test("a step the pin's map lacks is still drawn, after the step that ran before it", () => {
  const html = render(
    <LapStepsBody
      map={{ rows: map, state: 'ready' }}
      rows={[
        step({ step_id: 'pick', started_at: new Date('2026-10-25T12:00:00Z') }),
        step({ step_id: 'briefs', started_at: new Date('2026-10-25T12:01:00Z') }),
      ]}
      now={0}
    />,
  );
  expect(html).toMatch(
    /data-graph-step="briefs" data-step-state="finished" data-attempts="1" data-off-map="true"/,
  );
});

test("with no map stored for any pin, the lap's own steps are drawn in the order they ran", () => {
  const html = render(
    <LapStepsBody
      map={{ rows: [], state: 'ready' }}
      rows={[
        step({ step_id: 'pick', started_at: new Date('2026-10-25T12:00:00Z') }),
        step({ step_id: 'claim', status: 'running', started_at: new Date('2026-10-25T12:01:00Z') }),
      ]}
      now={Date.parse('2026-10-25T12:02:00Z')}
    />,
  );
  expect(html).toContain('No map is stored for any pin');
  expect(html).toMatch(/data-graph-step="claim" data-step-state="running"/);
  expect(html).toContain('0:01:00');
});
