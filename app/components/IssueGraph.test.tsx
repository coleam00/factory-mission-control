import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ISSUE_STATES, type IssueGraphRow } from '../lib/issue-graph';
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

const html = renderToStaticMarkup(<IssueScreen rows={rows} />);
const node = (n: number) => html.split('<a ').find((a) => a.includes(`data-issue="${n}"`)) ?? '';

test('each issue is one node in its state, linked to the issue', () => {
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
  expect(edgeClass('4-5')).toBe('stroke-border-bright');
});

test('each phase bar shows merged over total', () => {
  expect(html).toContain('data-phase="Skeleton" data-merged="0" data-total="3"');
  expect(html).toContain('data-phase="Screens" data-merged="1" data-total="3"');
  expect(html).toContain('aria-label="Screens: 1 of 3 merged"');
});
