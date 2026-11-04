import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { type ChangeItem, changeTimeline } from '../lib/changes';
import type { LedgerRow, TimelineRow } from '../lib/decisions-ledger';
import type { VersionStripRow } from '../lib/version-strip';
import { ChangeTimeline, Comparison } from './Changes';

const V1 = `sha256:${'a1'.repeat(32)}`;
const V2 = `sha256:${'b2'.repeat(32)}`;
const at = (day: number) => new Date(Date.UTC(2026, 9, day));

const strip: VersionStripRow[] = [
  {
    digest: V1,
    first_run_at: at(2),
    pin_sha: '1111111111',
    reason: 'one',
    committed_at: at(1),
    hypothesis: 'hyp',
    measure: 'meas',
  },
  {
    digest: V2,
    first_run_at: at(12),
    pin_sha: '2222222222',
    reason: 'two',
    committed_at: at(10),
    hypothesis: null,
    measure: '10 laps',
  },
  {
    digest: null,
    first_run_at: null,
    pin_sha: '3333333333',
    reason: 'pending',
    committed_at: at(25),
    hypothesis: null,
    measure: null,
  },
];
const ledgerRows: LedgerRow[] = [
  {
    pin_sha: '1111111111',
    reason: 'one',
    measure: 'meas',
    committed_at: at(1),
    laps: 4,
    verdict: 'helped',
    sentence: 'it helped',
    verdict_at: at(8),
    pin_matches: 1,
  },
  {
    pin_sha: '2222222222',
    reason: 'two',
    measure: '10 laps',
    committed_at: at(10),
    laps: 3,
    verdict: null,
    sentence: null,
    verdict_at: null,
    pin_matches: 1,
  },
];
const decisions: TimelineRow[] = [
  {
    date: '2026-10-11',
    title: 'Keep it',
    decision: 'we keep',
    why: 'because',
    replaces: 'nothing',
    version: '2222',
    pin_sha: '2222222222',
    ambiguous: false,
    digest: V2,
  },
];

function render(items: readonly ChangeItem[], pair: { a?: string; b?: string }): string {
  const router = createMemoryRouter([
    {
      path: '/',
      element: <ChangeTimeline items={items} pair={pair} onPick={() => {}} />,
    },
  ]);
  return renderToStaticMarkup(<RouterProvider router={router} />);
}

const items = changeTimeline(strip, ledgerRows, decisions);
const li = (html: string, marker: string) =>
  html.split('<li').find((chunk) => chunk.includes(marker)) ?? '';

test('each version, decision and chip is on the timeline, newest first', () => {
  const html = render(items, {});
  const order = [
    ...html.matchAll(
      /data-change="(version|decision)"[^>]*?(?:data-pin="(\d)|data-title="([^"]*))/g,
    ),
  ];
  expect(order.map((m) => m[2] ?? m[3])).toEqual(['3', '2', 'Keep it', '1']);
  expect(html).toContain('data-chip="helped"');
  expect(html).toContain('testing, 3 of 10 laps');
  expect(li(html, `data-digest="${V1}"`)).toContain('data-verdict="helped"');
  expect(html).toContain('because');
});

test('the checked boxes are the pair, and a pending pin has none', () => {
  const html = render(items, { a: V1, b: V2 });
  expect(html.match(/checked=""/g)).toHaveLength(2);
  expect(li(html, 'data-pin="3333333333"')).not.toContain('type="checkbox"');
  expect(li(html, 'data-pin="3333333333"')).toContain('not yet run');
  expect(render(items, { a: V1 }).match(/checked=""/g)).toHaveLength(1);
});

test('the comparison links the diff of the pair and uses no amber', () => {
  const router = createMemoryRouter([
    {
      path: '/',
      element: (
        <Comparison
          factory="mission-control"
          rows={[]}
          state="ready"
          pair={{ a: V1, b: V2, isDefault: false }}
          selectable={2}
          unavailable={{ absent: [], unplaced: [] }}
        />
      ),
    },
  ]);
  const html = renderToStaticMarkup(<RouterProvider router={router} />);
  expect(html).toContain(
    `href="/f/mission-control/diff?a=${encodeURIComponent(V1)}&amp;b=${encodeURIComponent(V2)}"`,
  );
  expect(html).toContain('what changed in the workflows');
  expect(render(items, {}) + html).not.toMatch(/warning|node-approval/);
});

test('with one selectable version the comparison says there is nothing to compare, not to select another', () => {
  const panel = (selectable: number) =>
    renderToStaticMarkup(
      <RouterProvider
        router={createMemoryRouter([
          {
            path: '/',
            element: (
              <Comparison
                factory="mission-control"
                rows={[]}
                state="ready"
                pair={{ a: V1, isDefault: true }}
                selectable={selectable}
                unavailable={{ absent: [], unplaced: [] }}
              />
            ),
          },
        ])}
      />,
    );
  const one = panel(1);
  expect(one).toContain('there is nothing to compare yet');
  expect(one).not.toContain('Select another version');
  expect(panel(2)).toContain('Select another version to compare.');
});

test('with zero selectable versions the comparison still renders and says there is nothing to compare', () => {
  const html = renderToStaticMarkup(
    <RouterProvider
      router={createMemoryRouter([
        {
          path: '/',
          element: (
            <Comparison
              factory="mission-control"
              rows={[]}
              state="ready"
              pair={{ isDefault: true }}
              selectable={0}
              unavailable={{ absent: [], unplaced: [] }}
            />
          ),
        },
      ])}
    />,
  );
  expect(html).toContain('Comparison');
  expect(html).toContain('No version has run yet, so there is nothing to compare.');
});

test('every version row but the oldest offers comparing with its previous version', () => {
  const html = render(items, {});
  expect(li(html, `data-digest="${V2}"`)).toContain(`data-compare-previous="${V1}"`);
  expect(li(html, `data-digest="${V1}"`)).not.toContain('data-compare-previous');
});

test('a version row shows its short digest so versions on one pin differ', () => {
  const html = render(items, {});
  expect(li(html, `data-digest="${V1}"`)).toContain(V1.slice(0, 19));
  expect(li(html, `data-digest="${V2}"`)).toContain(V2.slice(0, 19));
});

const view = (unavailable: { absent: string[]; unplaced: string[] }) =>
  renderToStaticMarkup(
    <RouterProvider
      router={createMemoryRouter([
        {
          path: '/',
          element: (
            <Comparison
              factory="mission-control"
              rows={[]}
              state="ready"
              pair={{ a: V1, isDefault: false }}
              selectable={2}
              unavailable={unavailable}
            />
          ),
        },
      ])}
    />,
  );

test('a linked comparison naming a version the factory lacks says so', () => {
  const ghost = `sha256:${'c3'.repeat(32)}`;
  expect(view({ absent: [ghost], unplaced: [] })).toContain(
    `The linked comparison is unavailable: ${ghost.slice(0, 19)} is not a version of this factory.`,
  );
  expect(view({ absent: [], unplaced: [] })).not.toContain('data-missing-version');
});

test('both reasons are told, each with its own digests', () => {
  const ghost = `sha256:${'c3'.repeat(32)}`;
  const lapOnly = `sha256:${'d4'.repeat(32)}`;
  const html = view({ absent: [ghost], unplaced: [lapOnly] });
  expect(html).toContain(`${ghost.slice(0, 19)} is not a version of this factory.`);
  expect(html).toContain(`${lapOnly.slice(0, 19)} is not on the timeline yet.`);
});
