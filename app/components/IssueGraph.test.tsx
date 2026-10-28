import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ISSUE_STATES, type IssueGraphRow, type IssueState } from '../lib/issue-graph';
import { IssueScreen } from './IssueGraph';

const rows: IssueGraphRow[] = [
  ...ISSUE_STATES.map((state, i) => ({
    kind: 'issue' as const,
    number: i + 1,
    title: `Issue ${i + 1}`,
    phase: i < 3 ? 'Skeleton' : 'Screens',
    url: `https://github.com/o/r/issues/${i + 1}`,
    state,
    depends_on: null,
  })),
  // waiting #1 -> claimed #2 -> pr-open #3 is the open chain; needs-owner #4 depends on merged #5.
  ...[
    [1, 2],
    [2, 3],
    [4, 5],
  ].map(([number, dependsOn]) => ({
    kind: 'edge' as const,
    number,
    title: null,
    phase: null,
    url: null,
    state: null,
    depends_on: dependsOn,
  })),
];

const html = renderToStaticMarkup(<IssueScreen rows={rows} showMerged />);
const node = (n: number) => html.split('<a ').find((a) => a.includes(`data-issue="${n}"`)) ?? '';
const byDefault = renderToStaticMarkup(<IssueScreen rows={rows} />);
const drawn = (markup: string) =>
  [...markup.matchAll(/<a [^>]*data-issue="(\d+)"/g)].map((m) => Number(m[1]));

test('with Show merged each issue is one node in its state, linked to the issue', () => {
  expect(html).toContain('aria-pressed="true"');
  ISSUE_STATES.forEach((state, i) => {
    expect(node(i + 1)).toContain(`data-issue-state="${state}"`);
    expect(node(i + 1)).toContain(`href="https://github.com/o/r/issues/${i + 1}"`);
  });
});

test('only the longest open chain carries data-longest-chain, and its edges stand out', () => {
  const marked = [...html.matchAll(/data-issue="(\d+)"[^>]*data-longest-chain="true"/g)].map((m) =>
    Number(m[1]),
  );
  expect(marked).toEqual([1, 2, 3]);
  const edgeClass = (id: string) =>
    new RegExp(`data-dependency="${id}"[^>]*class="([^"]+)"`).exec(html)?.[1];
  expect(edgeClass('1-2')).toBe('stroke-text-primary');
  // #4 depends on merged #5: a satisfied edge, drawn faint and dashed rather than highlighted.
  expect(edgeClass('4-5')).toBe('stroke-border-bright');
  expect(html).toMatch(/data-dependency="4-5" data-satisfied="true"[^>]*stroke-dasharray="4 4"/);
  expect(html).not.toMatch(/data-dependency="1-2" data-satisfied/);
});

test('each phase bar shows merged over total', () => {
  expect(html).toContain('data-phase="Skeleton" data-merged="0" data-total="3"');
  expect(html).toContain('data-phase="Screens" data-merged="1" data-total="3"');
  expect(html).toContain('aria-label="Screens: 1 of 3 merged"');
});

test('by default merged and closed issues are not drawn unless an open one depends on them', () => {
  // Open: 1, 2, 3, 4. Merged #5 stays because needs-owner #4 depends on it; closed #6 goes.
  expect(drawn(byDefault)).toEqual([1, 2, 3, 4, 5]);
  expect(byDefault).toMatch(/data-issue="5"[^>]*data-context="true"/);
  expect(byDefault).toContain('aria-pressed="false"');
  expect(byDefault).toContain('Show merged');
  expect([...byDefault.matchAll(/data-dependency="([\d-]+)"/g)].map((m) => m[1]).sort()).toEqual([
    '1-2',
    '2-3',
    '4-5',
  ]);
});

test('each phase is a column with its open, merged and closed counts', () => {
  expect(byDefault).toContain(
    'data-phase-column="Skeleton" data-open="3" data-merged="0" data-closed="0"',
  );
  expect(byDefault).toContain(
    'data-phase-column="Screens" data-open="1" data-merged="1" data-closed="1"',
  );
  expect(byDefault).toContain('aria-label="Screens: 1 open · 1 merged · 1 closed"');
});

test('north-star: no phases, mostly merged, shows its open issues under No phase', () => {
  const unphased: IssueGraphRow[] = [
    ...Array.from({ length: 25 }, (_, n) => ({
      kind: 'issue' as const,
      number: n + 1,
      title: `Issue ${n + 1}`,
      phase: null,
      url: `https://github.com/o/north-star/issues/${n + 1}`,
      state: (n < 23 ? 'merged' : 'waiting') as IssueState,
      depends_on: null,
    })),
  ];
  const markup = renderToStaticMarkup(<IssueScreen rows={unphased} />);
  expect(markup).toContain('No issue names a phase yet.');
  expect(markup).toContain('data-phase-column="" data-open="2" data-merged="23" data-closed="0"');
  expect(markup).toContain('No phase');
  expect(drawn(markup)).toEqual([24, 25]);
});
