import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { createMemoryRouter, RouterProvider } from 'react-router';
import type { OneLapRow, StepAttemptRow } from '../lib/one-lap';
import { RunView, type TabKey, tabOf } from './OneRun';

const RUN = '5eed0005-0000-4000-8000-000000000017';
const GROUP = 'ship__deliver__rounds';
const NOW = Date.parse('2026-10-20T12:00:00Z');

const lap: OneLapRow = {
  run_id: RUN,
  workflow_name: 'archon-build-queue',
  status: 'failed',
  started_at: new Date('2026-10-20T10:00:00Z'),
  completed_at: new Date('2026-10-20T11:53:00Z'),
  repository: 'coleam00/queue-factory',
  console: 'http://localhost:3090',
  issue_number: 485,
  issue_title: null,
  issue_url: null,
  route: null,
  depth: null,
  pr_number: 496,
  review_status: null,
  review_outcome: null,
  review_delivers: null,
  dispositions: null,
  hidden_lines: [],
  gate_status: null,
  gate_outcome: null,
  gate_reason: null,
  stop_status: 'failed',
  stop_step: `${GROUP}.pr__prepare`,
  stop_line: "Script node 'pr__prepare' failed [exit 1]",
  stop_class: 'environment',
  capacity_since: null,
};

let minute = 0;
const step = (step_id: string, over: Partial<StepAttemptRow> = {}): StepAttemptRow => ({
  step_id,
  status: 'completed',
  started_at: new Date(Date.UTC(2026, 9, 20, 10, minute++)),
  duration_ms: 60_000,
  model: null,
  tokens_input: 1_000_000,
  tokens_output: null,
  tokens_cache_read: null,
  tokens_cache_write: null,
  cost_usd: '1',
  outcome: null,
  error: null,
  position: null,
  ...over,
});

const rows: StepAttemptRow[] = [
  step('facts', { cost_usd: null, tokens_input: null }),
  step(`${GROUP}.implement`, { cost_usd: '5' }),
  step(`${GROUP}.pr__prepare`, { cost_usd: '0.5' }),
  step(`${GROUP}.review__result`, { cost_usd: '1.5' }),
  step(`${GROUP}.round`, { cost_usd: '0.25' }),
  step(`${GROUP}.implement`, { cost_usd: '6' }),
  step(`${GROUP}.pr__prepare`, {
    status: 'failed',
    cost_usd: '0.5',
    error: "Script node 'pr__prepare' failed [exit 1]\n$ git push\n ! [rejected]",
  }),
  step(`${GROUP}.review__result`, { status: 'skipped', cost_usd: null, duration_ms: 0 }),
];

function render(view: Partial<Parameters<typeof RunView>[0]> & { tab?: TabKey } = {}): string {
  const element = (
    <RunView
      lap={lap}
      rows={rows}
      map={{ rows: [], state: 'ready' }}
      factory="queue-factory"
      tab="timeline"
      checksPanel={<p>checks</p>}
      now={NOW}
      {...view}
    />
  );
  const router = createMemoryRouter([{ path: '/', element }]);
  return renderToStaticMarkup(<RouterProvider router={router} />);
}

test('the head says what the run is, its state, workflow, pull request, time, cost and tokens', () => {
  const html = render();
  expect(html).toContain('data-title="Build #485, round 2"');
  expect(html).toContain('href="https://github.com/coleam00/queue-factory/issues/485"');
  expect(html).toContain('>Failed<');
  expect(html).toContain('>archon-build-queue<');
  expect(html).toContain('href="https://github.com/coleam00/queue-factory/pull/496"');
  expect(html).toContain('data-run-cost="13.75"');
  expect(html).toContain('data-run-tokens="7000000"');
  expect(html).toContain('1h 53m · $13.75 · 7,000,000 tokens in');
  expect(html).toContain('href="/f/queue-factory/runs"');
});

test('a run waiting for a slot shows that state, not "Needs you"', () => {
  const html = render({
    lap: { ...lap, status: 'paused', stop_step: 'ask', capacity_since: new Date(NOW) },
  });
  expect(html).toContain('>Waiting for a slot<');
  expect(html).not.toContain('>Needs you<');
  expect(html).toContain('waiting for a free slot');
  expect(html).not.toContain('Answer in console');
});

test('the head stays one row on a desktop, so the actions keep the top right beside the Manager dock', () => {
  const html = render();
  expect(html).toContain('min-[760px]:flex-nowrap');
  expect(html).toContain('flex shrink-0 gap-2');
  expect(html).toContain('absolute top-1.5 flex h-[1lh] items-center');
});

test("the manager's read comes from the stop record, and the primary action opens the console run", () => {
  const html = render();
  expect(html).toContain('data-manager-read');
  expect(html).toContain('data-code-failure="no"');
  expect(html).toContain('data-stop-class="environment"');
  expect(html).toContain('data-resume-step="pr__prepare"');
  expect(html).toContain('This is not a code failure: the environment refused it.');
  expect(html).toContain(
    `data-action="primary" href="http://localhost:3090/console/r/${RUN}" class="`,
  );
  expect(html).toContain('Resume from pr__prepare');
});

test('the timeline is the default tab: round 1 folded, round 2 open, the failure expanded, the skip explained', () => {
  const html = render();
  expect(html).toContain('data-loop="ship__deliver__rounds"');
  expect(html).toContain('loop · 2 rounds');
  expect(html).toContain('data-round="1" data-round-cost="7.25"');
  expect(html).toContain('implement → pr__prepare → review__result → round');
  expect(html).toContain('round 2 · implement');
  expect(html.match(/data-error-panel/g)).toHaveLength(1);
  expect(html).toContain(`>Resume from here</a>`);
  expect(html).toMatch(/<button[^>]*>Ask manager<\/button>/);
  expect(html).toContain('data-skipped-count="1"');
  expect(html).toContain('1 skipped');
  expect(html).not.toContain('skipped: ');
  expect(html).not.toContain('data-timeline-step="ship__deliver__rounds.review__result"');
  expect(html).not.toContain('data-step-attempt');
});

test('an expanded skipped group names the recorded reason and never reads "skipped: skipped"', () => {
  const html = render({ skippedOpen: true });
  expect(html).toContain('data-timeline-step="ship__deliver__rounds.review__result"');
  expect(html).toContain('upstream failed');
  expect(html).not.toContain('skipped: ');
});

test('the Steps tab keeps the attempt rows and the run cost the live phase reads', () => {
  const html = render({ tab: 'steps' });
  expect(html.match(/data-step-attempt/g)).toHaveLength(rows.length);
  expect(html).toContain('data-lap-cost="13.75"');
  expect(html).toContain('checks');
  expect(html).not.toContain('data-timeline-step');
});

test('review and the merge gate show on an old loop run only', () => {
  expect(render({ tab: 'steps' })).not.toContain('data-review');
  const old = render({ tab: 'steps', lap: { ...lap, workflow_name: 'archon-loop' } });
  expect(old).toContain('data-review');
  expect(old).toContain('data-gate');
});

test('an address names a tab or opens the timeline', () => {
  expect(tabOf(null)).toBe('timeline');
  expect(tabOf('steps')).toBe('steps');
  expect(tabOf('nonsense')).toBe('timeline');
  const log = render({ tab: 'log' });
  expect(log).toContain(`data-link="console-tab"`);
  expect(log).not.toContain('data-timeline-step');
});

test('a finished run with a retried failure shows no error panel or resume', () => {
  const retried = [step('build', { status: 'failed', error: 'boom' }), step('build'), step('land')];
  const html = render({ lap: { ...lap, status: 'completed', stop_step: null }, rows: retried });
  expect(html).not.toContain('data-error-panel');
  expect(html).not.toContain('Resume from here');
});

test('a failed run with an earlier retried failure shows one error panel and one resume, on the stop attempt', () => {
  const html = render({
    rows: [step('build', { status: 'failed', error: 'boom' }), step('build'), ...rows],
  });
  expect(html.match(/data-error-panel/g)).toHaveLength(1);
  expect(html.match(/>Resume from here</g)).toHaveLength(1);
  const panel = html.indexOf('data-error-panel');
  expect(html.slice(html.lastIndexOf('data-timeline-step=', panel))).toStartWith(
    'data-timeline-step="ship__deliver__rounds.pr__prepare" data-status="failed"',
  );
});
