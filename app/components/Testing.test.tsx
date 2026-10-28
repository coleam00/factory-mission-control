import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { MARKER } from '../../scripts/fixture/seed-report';
import type { CheckRow, DefaultHoldoutRow, RouteRow } from '../lib/testing';
import { AppChecks, CheckBars, DefaultBranchHoldouts, PrHoldouts, RouteGrid } from './Testing';

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
  repository: 'coleam00/factory-mission-control',
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

/**
 * Each counted element's `data-count`, and how many `[data-lap]` sit inside it: the element is
 * cut at its own closing tag, found by counting the same tag's opens and closes.
 */
function counts(html: string, attribute: string): [string, number][] {
  return html
    .split(new RegExp(`(?=<\\w+ ${attribute}="true")`))
    .slice(1)
    .map((rest) => {
      const tag = rest.match(/^<(\w+)/)?.[1] ?? '';
      const open = new RegExp(`<${tag}[ >]|</${tag}>`, 'g');
      let depth = 0;
      let end = rest.length;
      for (const m of rest.matchAll(open)) {
        depth += m[0].startsWith('</') ? -1 : 1;
        if (depth === 0) {
          end = (m.index ?? 0) + m[0].length;
          break;
        }
      }
      const element = rest.slice(0, end);
      return [
        element.match(/data-count="(\d+)"/)?.[1] ?? '',
        element.split('data-lap=').length - 1,
      ];
    });
}

test('no part of the screen is an HTML table', () => {
  const html = [
    render(<RouteGrid rows={routes} factory="mission-control" />),
    render(<AppChecks rows={[check(1, 1, {})]} factory="mission-control" />),
    render(<DefaultBranchHoldouts rows={holdouts} />),
  ].join('');
  expect(html).not.toMatch(/<(table|thead|tbody|tr|td|th)[ >]/);
});

test('each route-by-depth cell counts its laps, and opens exactly those laps', () => {
  const html = render(<RouteGrid rows={routes} factory="mission-control" />);
  expect(html).toContain('data-route="simple" data-depth="normal" data-count="2"');
  expect(html).toContain('data-route="" data-depth="" data-count="1"');
  expect(html).toContain('not picked');
  expect(html).toContain(`href="/f/mission-control/laps/${lap(3)}"`);
  expect(counts(html, 'data-route-mix')).toEqual([
    ['2', 2],
    ['1', 1],
  ]);
  // Four routes and a not-picked row, by three depths and a not-picked column; two cells filled.
  for (const route of ['simple', 'continue', 'complex', 'none']) expect(html).toContain(route);
  expect(html.split('data-route-mix=').length - 1).toBe(2);
  expect(html).toContain('aria-label="simple route, normal depth: 2 laps. Open them."');
});

test('a route or depth the grid does not name still gets its own row and column', () => {
  const html = render(
    <RouteGrid
      rows={[{ ...routes[0], route: 'rescue', depth: 'exhaustive' }]}
      factory="mission-control"
    />,
  );
  expect(html).toContain('data-route="rescue" data-depth="exhaustive" data-count="1"');
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
    const found = counts(html, attribute);
    expect(found.length).toBeGreaterThan(0);
    for (const [count, listed] of found) expect(Number(count)).toBe(listed);
  }
});

test('each kind is one bar, its verdicts segments of it, passing first', () => {
  const rows = [
    check(1, 1, { kind: 'holdout', verdict: 'FAIL', scenario_id: 'H-02' }),
    check(1, 2, { kind: 'holdout', scenario_id: 'H-01' }),
    check(2, 1, { kind: 'holdout', scenario_id: 'H-01' }),
    check(2, 2, { kind: 'probe', verdict: 'OK' }),
  ];
  const html = render(<CheckBars rows={rows} factory="mission-control" />);
  expect(html.split('data-kind-bar=').length - 1).toBe(2);
  expect(html).toContain('data-kind-bar="true" data-kind="holdout" data-count="3"');
  expect(html.indexOf('data-verdict="PASS"')).toBeLessThan(html.indexOf('data-verdict="FAIL"'));
  expect(html).toContain('aria-label="holdout: 2 lines PASS. Open them."');
});

test('one tile per scenario: its counts by verdict, a bar of them, its lines behind a click', () => {
  const rows = [
    check(1, 1, { kind: 'holdout', scenario_id: 'H-07' }),
    check(2, 1, { kind: 'holdout', scenario_id: 'H-07' }),
    check(3, 1, { kind: 'holdout', verdict: 'FAIL', scenario_id: 'H-07' }),
    check(3, 2, { kind: 'holdout', verdict: 'INCOMPLETE', scenario_id: 'H-07' }),
    check(1, 2, { kind: 'holdout', scenario_id: 'H-10' }),
  ];
  const html = render(<PrHoldouts rows={rows} factory="mission-control" />);
  expect(html.split('data-scenario-tile=').length - 1).toBe(2);
  expect(html).toContain('data-scenario-tile="true" data-scenario="H-07" data-count="4"');
  expect(html).toContain('H-07 · 2 PASS, 1 FAIL, 1 INCOMPLETE');
  // The tile's button opens the popover holding its lines.
  const target = html.match(/popovertarget="([^"]+)"/i)?.[1];
  expect(target).toBeDefined();
  expect(html).toContain(`id="${target}" popover="auto"`);
  expect(counts(html, 'data-pr-holdout')).toEqual([
    ['2', 2],
    ['1', 1],
    ['1', 1],
    ['1', 1],
  ]);
});

test('a factory whose holdout lines carry no id shows one unidentified tile', () => {
  const rows = [1, 2, 3].map((n) =>
    check(n, 1, {
      kind: 'holdout',
      verdict: n === 2 ? 'FAIL' : 'PASS',
      scenario_id: 'unidentified',
    }),
  );
  const html = render(<PrHoldouts rows={rows} factory="north-star" />);
  expect(html.split('data-scenario-tile=').length - 1).toBe(1);
  expect(html).toContain('data-scenario-tile="true" data-scenario="unidentified" data-count="3"');
});

test("the default branch's failing scenario shows its tracking issue on its tile", () => {
  const html = render(<DefaultBranchHoldouts rows={holdouts} />);
  expect(html).toContain('data-holdouts-at="3e4f5a6b"');
  expect(html).toContain('2026-10-24 09:00 UTC');
  expect(html).toContain('data-default-holdout="true" data-scenario="H-01" data-verdict="PASS"');
  expect(html).toMatch(
    /data-failing="true" data-scenario="H-02" data-verdict="FAIL" data-issue="14"/,
  );
  expect(html).toContain('href="https://github.com/coleam00/factory-mission-control/issues/14"');
  expect(html).toContain('#14 Phases and the issue graph');
  expect(html).toMatch(/<a data-link="issue"[^>]*>#14<\/a>/);
  expect(html.split('data-failing=').length - 1).toBe(1);
});

test('a tracking issue not mirrored yet still links to the factory repository', () => {
  const html = render(
    <DefaultBranchHoldouts
      rows={[{ ...report, scenario_id: 'H-20', verdict: 'FAIL', issue_number: 43 }]}
    />,
  );
  expect(html).toContain(
    '<a data-link="issue" href="https://github.com/coleam00/factory-mission-control/issues/43"',
  );
  expect(html).not.toMatch(/<span[^>]*>#43<\/span>/);
});

test('each panel has a one-sentence empty state', () => {
  expect(render(<RouteGrid rows={[]} factory="second-factory" />)).toContain(
    'No laps in this factory yet.',
  );
  const checks = render(<AppChecks rows={[]} factory="second-factory" />);
  expect(checks).toContain('No app check has reported in this factory.');
  expect(checks).toContain('No holdout line in any app check yet.');
  expect(render(<DefaultBranchHoldouts rows={[]} />)).toContain(
    'No holdouts line for this factory yet.',
  );
  expect(render(<DefaultBranchHoldouts rows={[holdouts[0]]} />)).toContain(
    'No scenario fails on the default branch.',
  );
});
