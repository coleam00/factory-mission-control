import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { lapHref } from '../lib/one-lap';
import {
  filterOf,
  RUNS_PAGE_SIZE,
  type RunRow,
  type RunsFilter,
  type RunsRow,
  runsView,
} from '../lib/runs';
import {
  addressOf,
  nextFilter,
  Pager,
  pageWithin,
  placeOf,
  RunFilters,
  RunList,
  Runs,
} from './Runs';

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

test('a run with no round, step or PR still shows its item on the narrow row', () => {
  expect(list([run({ issue_number: 42 })])).toContain('>#42</span></span>');
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

const filter = (over: Partial<RunsFilter> = {}): RunsFilter => ({
  q: '',
  state: '',
  hideIdle: true,
  page: 1,
  ...over,
});

test('an address with no idle parameter hides idle polls', () => {
  expect(filterOf(new URLSearchParams('')).hideIdle).toBe(true);
  expect(filterOf(new URLSearchParams('idle=show')).hideIdle).toBe(false);
});

test('a page the address cannot read is page 1', () => {
  expect(filterOf(new URLSearchParams('page=0')).page).toBe(1);
  expect(filterOf(new URLSearchParams('page=abc')).page).toBe(1);
  expect(filterOf(new URLSearchParams('page=3')).page).toBe(3);
});

test('a page past the query offset range is held to the last page the offset can hold', () => {
  const page = filterOf(new URLSearchParams('page=99999999999999999999')).page;
  expect(page * RUNS_PAGE_SIZE).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER);
  expect(page).toBeGreaterThan(1);
});

test('a filter change made from page 3 leaves the page out of the address', () => {
  const from = filterOf(new URLSearchParams('page=3&state=failed'));
  expect(from.page).toBe(3);
  expect(addressOf(nextFilter(from, { q: 'fix' })).toString()).toBe('q=fix&state=failed');
  expect(addressOf(nextFilter(from, { state: 'done' })).has('page')).toBe(false);
  expect(addressOf(nextFilter(from, { hideIdle: false })).has('page')).toBe(false);
});

test('a page past the last page of the chip lands on the last page', () => {
  const counts = { all_count: 51 } as RunsRow;
  expect(pageWithin(counts, filter({ page: 3 }))).toBe(2);
  expect(pageWithin(counts, filter({ page: 2 }))).toBe(2);
  expect(pageWithin({ all_count: 0 } as RunsRow, filter({ page: 3 }))).toBe(1);
  expect(pageWithin(undefined, filter({ page: 3 }))).toBe(3);
  expect(
    pageWithin(
      { all_count: 100, failed_count: 3 } as RunsRow,
      filter({ state: 'failed', page: 2 }),
    ),
  ).toBe(1);
});

function pager(total: number): string {
  const counts = { all_count: total } as RunsRow;
  return renderToStaticMarkup(<Pager counts={counts} filter={filter()} onChange={() => {}} />);
}

test('the pager shows nothing at one full page and the range at one run more', () => {
  expect(pager(RUNS_PAGE_SIZE)).toBe('');
  expect(pager(RUNS_PAGE_SIZE + 1)).toContain('1–50 of 51');
});

test('the address names the view: ?view=failures is Failures, anything else is every run', () => {
  expect(placeOf(new URLSearchParams('view=failures'))).toBe('failures');
  expect(placeOf(new URLSearchParams(''))).toBe('all');
  expect(placeOf(new URLSearchParams('view=other'))).toBe('all');
});

test('the head has the All runs / Failures control at its right', () => {
  const html = render(
    <RunFilters
      counts={undefined}
      filter={filterOf(new URLSearchParams(''))}
      draft=""
      onDraft={() => {}}
      onChange={() => {}}
      switcher={<span data-switcher />}
    />,
  );
  expect(html).toContain('data-switcher');
});

const renderRuns = (search: string): string =>
  renderToStaticMarkup(
    <RouterProvider
      router={createMemoryRouter([{ path: '/', element: <Runs factory="x" /> }], {
        initialEntries: [`/${search}`],
      })}
    />,
  );

test('Runs renders the failure groups with Failures selected for ?view=failures, and every run for the bare address', () => {
  const failures = renderRuns('?view=failures');
  expect(failures).toContain('data-live="failure-groups"');
  expect(failures).toMatch(/aria-pressed="true"[^>]*>Failures</);
  const all = renderRuns('');
  expect(all).toContain('data-live="runs"');
  expect(all).not.toContain('data-live="failure-groups"');
  expect(all).toMatch(/aria-pressed="true"[^>]*>All runs</);
});
