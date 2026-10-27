import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { MARKER } from '../../scripts/fixture/seed-report';
import type { CheckRow, DefaultHoldoutRow, RouteRow } from '../lib/testing';
import { AppChecks, DefaultBranchHoldouts, RouteList } from './Testing';

function render(element: React.ReactElement): string {
  const router = createMemoryRouter([{ path: '/', element }]);
  return renderToStaticMarkup(<RouterProvider router={router} />);
}

const lap = (n: number) => `5eed0001-0000-4000-8000-${String(n).padStart(12, '0')}`;

const routes: RouteRow[] = [
  {
    run_id: lap(1),
    status: 'completed',
    started_at: new Date('2026-10-01T08:00:00Z'),
    route: 'simple',
    depth: 'normal',
  },
  {
    run_id: lap(2),
    status: 'completed',
    started_at: new Date('2026-10-02T08:00:00Z'),
    route: 'simple',
    depth: 'normal',
  },
  { run_id: lap(3), status: 'pending', started_at: null, route: null, depth: null },
];

const check = (n: number, position: number, over: Partial<CheckRow>): CheckRow => ({
  run_id: lap(n),
  position,
  kind: 'criterion',
  verdict: 'PASS',
  scenario_id: null,
  started_at: new Date(`2026-10-0${n}T08:00:00Z`),
  pr: `#${100 + n}`,
  ...over,
});

const report = {
  at: new Date('2026-10-24T09:00:00Z'),
  sha: '3e4f5a6b',
  report_issue: 18,
  issue_title: null,
  issue_state: null,
  issue_url: null,
};
const holdouts: DefaultHoldoutRow[] = [
  { ...report, scenario_id: 'H-01', verdict: 'PASS', issue_number: null },
  {
    ...report,
    scenario_id: 'H-02',
    verdict: 'FAIL',
    issue_number: 14,
    issue_title: 'Phases and the issue graph',
    issue_state: 'open',
    issue_url: 'https://github.com/coleam00/factory-mission-control/issues/14',
  },
];

/** Each counted row's `data-count`, and how many `li[data-lap]` it lists. */
function counts(html: string, attribute: string): [string, number][] {
  return html
    .split(`<li ${attribute}="true"`)
    .slice(1)
    .map((row) => [
      row.match(/data-count="(\d+)"/)?.[1] ?? '',
      row.split('</details>')[0].split('data-lap=').length - 1,
    ]);
}

test('each route and depth counts its laps, and lists exactly those laps', () => {
  const html = render(<RouteList rows={routes} factory="mission-control" />);
  expect(html).toContain('data-route="simple" data-depth="normal" data-count="2"');
  expect(html).toContain('data-route="" data-depth="" data-count="1"');
  expect(html).toContain('not picked yet');
  expect(html).toContain(`href="/f/mission-control/laps/${lap(3)}"`);
  expect(counts(html, 'data-route-mix')).toEqual([
    ['2', 2],
    ['1', 1],
  ]);
});

test('app-check lines count by kind and verdict, holdouts by scenario id, never their text', () => {
  const rows = [
    check(1, 1, {}),
    check(2, 1, {}),
    // A row may carry more than the query selects; the screen renders none of it.
    { ...check(1, 2, { kind: 'holdout', scenario_id: 'H-01' }), text: MARKER } as CheckRow,
    check(2, 2, { kind: 'holdout', verdict: 'FAIL', scenario_id: 'unidentified', pr: null }),
  ];
  const html = render(<AppChecks rows={rows} factory="mission-control" />);
  expect(html).toContain('data-kind="criterion" data-verdict="PASS" data-count="2"');
  expect(html).toContain('data-kind="holdout" data-verdict="FAIL" data-count="1"');
  expect(html).toContain('data-scenario="H-01" data-verdict="PASS" data-count="1"');
  expect(html).toContain('data-scenario="unidentified" data-verdict="FAIL" data-count="1"');
  expect(html).toContain('pull request #101');
  expect(html).toContain('no pull request');
  expect(html).not.toContain(MARKER);
  for (const attribute of ['data-check-mix', 'data-pr-holdout']) {
    for (const [count, listed] of counts(html, attribute)) expect(Number(count)).toBe(listed);
  }
});

test("the default branch's failing scenario shows its tracking issue", () => {
  const html = render(<DefaultBranchHoldouts rows={holdouts} />);
  expect(html).toContain('data-holdouts-at="3e4f5a6b"');
  expect(html).toContain('2026-10-24 09:00 UTC');
  expect(html).toContain('data-default-holdout="true" data-scenario="H-01" data-verdict="PASS"');
  expect(html).toMatch(/data-failing="true" data-scenario="H-02" data-issue="14"/);
  expect(html).toContain('href="https://github.com/coleam00/factory-mission-control/issues/14"');
  expect(html).toContain('#14 Phases and the issue graph');
  expect(html.split('data-failing=').length - 1).toBe(1);
});

test('each panel has a one-sentence empty state', () => {
  expect(render(<RouteList rows={[]} factory="second-factory" />)).toContain(
    'No laps in this factory yet.',
  );
  const checks = render(<AppChecks rows={[]} factory="second-factory" />);
  expect(checks).toContain('No app check has reported in this factory.');
  expect(checks).toContain('No holdout line in any app check yet.');
  const branch = render(<DefaultBranchHoldouts rows={[]} />);
  expect(branch).toContain('No holdouts line for this factory yet.');
  expect(branch).toContain('No scenario fails on the default branch.');
});
