import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { lapHref } from '../lib/one-lap';
import { type RunRow, type RunsRow, runsView } from '../lib/runs';
import { RunFilters, RunList } from './Runs';

const render = (element: React.ReactElement): string =>
  renderToStaticMarkup(<RouterProvider router={createMemoryRouter([{ path: '/', element }])} />);

const RUN = '5eed0003-0000-4000-8000-00000000000a';

const run = (over: Partial<RunRow> = {}): RunRow => ({
  all_count: 12,
  running_count: 1,
  needs_you_count: 2,
  failed_count: 3,
  done_count: 5,
  idle_count: 1,
  idle_polls: 4,
  run_id: RUN,
  position: 1,
  workflow_name: 'archon-build-queue',
  status: 'completed',
  state: 'done',
  idle_poll: false,
  started_at: new Date('2026-10-21T09:00:00Z'),
  completed_at: new Date('2026-10-21T09:46:00Z'),
  issue_number: 11,
  issue_title: null,
  stop_step: null,
  stop_line: null,
  round: null,
  step_id: null,
  pr_number: null,
  cost_usd: '1.3',
  ...over,
});

const list = (runs: RunRow[], searching = false) =>
  render(<RunList runs={runs} factory="mission-control" searching={searching} now={0} />);

test('a failed run shows its step and error in the failed color, a paused one what it asks', () => {
  const html = list([
    run({ state: 'failed', stop_step: 'ship__build', stop_line: '429 usage limit reached' }),
    run({ run_id: 'b', state: 'needs-you', stop_line: 'Merge it?' }),
  ]);
  expect(html).toContain('data-step="ship__build"');
  expect(html).toContain('data-stop="429 usage limit reached"');
  expect(html).toMatch(/style="color:var\(--v3-failed\)[^"]*"[^>]*>429 usage limit reached/);
  expect(html).toContain('Asking: Merge it?');
});

test('a row opens its run, and shows - for a took or cost it does not have', () => {
  const html = list([run({ started_at: null, cost_usd: null, issue_number: null })]);
  expect(html).toContain(`href="${lapHref('mission-control', RUN)}"`);
  expect(html).toContain('>-<');
  expect(html).not.toContain('$');
});

test('an empty page says so, differently for a search', () => {
  expect(list([])).toContain('No runs yet.');
  expect(list([], true)).toContain('No run matches.');
});

test('the six chips show their counts and the toggle is on and counts the idle polls', () => {
  const counts = runsView([run()]).counts as RunsRow;
  const html = render(
    <RunFilters
      counts={counts}
      filter={{ q: '', state: '', hideIdle: true, page: 1 }}
      draft=""
      onDraft={() => {}}
      onChange={() => {}}
    />,
  );
  const chips = [...html.matchAll(/<button[^>]*aria-pressed[^>]*>(.*?)<\/button>/g)].map((m) =>
    m[1].replace(/<[^>]*>/g, ''),
  );
  expect(chips).toEqual(['All12', 'Running1', 'Needs you2', 'Failed3', 'Done5', 'Cancelled1']);
  expect(html).toMatch(
    /role="switch"[^>]*aria-checked="true"|aria-checked="true"[^>]*role="switch"/,
  );
  expect(html).toContain('Hide idle polls (4)');
});
