import { expect, test } from 'bun:test';
import {
  type IssueGraph,
  type IssueGraphRow,
  type IssueState,
  issueGraph,
  layoutGraph,
  longestOpenChain,
  NODE,
  phaseBars,
} from './issue-graph';

const issue = (
  number: number,
  state: IssueState,
  phase: string | null = 'Screens',
): IssueGraphRow => ({
  kind: 'issue',
  number,
  title: `Issue ${number}`,
  phase,
  url: `https://github.com/o/r/issues/${number}`,
  state,
  depends_on: null,
});

const edge = (number: number, dependsOn: number): IssueGraphRow => ({
  kind: 'edge',
  number,
  title: null,
  phase: null,
  url: null,
  state: null,
  depends_on: dependsOn,
});

const graph = (rows: IssueGraphRow[]): IssueGraph => issueGraph(rows);

test('edges to an issue the factory does not have are left out of the graph', () => {
  const g = graph([edge(2, 1), edge(2, 99), issue(2, 'waiting'), issue(1, 'merged')]);
  expect(g.issues.map((i) => i.number)).toEqual([1, 2]);
  expect(g.dependencies).toEqual([{ from: 2, on: 1 }]);
});

test('a phase bar counts merged issues, not closed ones, and an issue with no phase has no bar', () => {
  const g = graph([
    issue(1, 'merged', 'Skeleton'),
    issue(2, 'closed', 'Skeleton'),
    issue(3, 'waiting', 'Screens'),
    issue(4, 'merged', 'Screens'),
    issue(5, 'pr-open', 'Skeleton'),
    issue(6, 'waiting', null),
  ]);
  expect(phaseBars(g.issues)).toEqual([
    { phase: 'Skeleton', merged: 1, total: 3 },
    { phase: 'Screens', merged: 1, total: 2 },
  ]);
});

test('the longest open chain runs through open issues only, from the dependent end', () => {
  // The seed's shape: 15 -> 14 -> 13 -> 9 open, 9 depends on a merged 8.
  const g = graph([
    issue(8, 'merged'),
    issue(9, 'pr-open'),
    issue(13, 'needs-owner'),
    issue(14, 'waiting'),
    issue(15, 'waiting'),
    issue(12, 'claimed'),
    edge(9, 8),
    edge(13, 9),
    edge(14, 13),
    edge(15, 14),
    edge(12, 8),
  ]);
  expect(longestOpenChain(g)).toEqual([15, 14, 13, 9]);
});

test('of two chains as long, the one with the lower numbers is highlighted', () => {
  const g = graph([
    issue(1, 'waiting'),
    issue(2, 'waiting'),
    issue(3, 'waiting'),
    issue(4, 'waiting'),
    edge(4, 3),
    edge(2, 1),
  ]);
  expect(longestOpenChain(g)).toEqual([2, 1]);
});

test('no chain is highlighted when no open issue depends on another open one', () => {
  const g = graph([issue(1, 'merged'), issue(2, 'waiting'), issue(3, 'closed'), edge(2, 1)]);
  expect(longestOpenChain(g)).toEqual([]);
});

test('a dependency cycle ends the chain instead of looping', () => {
  const g = graph([
    issue(1, 'waiting'),
    issue(2, 'waiting'),
    issue(3, 'waiting'),
    edge(1, 2),
    edge(2, 3),
    edge(3, 1),
  ]);
  expect(longestOpenChain(g)).toHaveLength(3);
});

test('a chain found while a cycle was cut is not reused as the longest from that issue', () => {
  // From 1 the walk reaches 2 while 1 is in progress, so 2's chain then stops short of 1.
  const g = graph([
    issue(1, 'waiting'),
    issue(2, 'waiting'),
    issue(3, 'waiting'),
    issue(5, 'waiting'),
    issue(6, 'waiting'),
    edge(1, 2),
    edge(2, 1),
    edge(1, 5),
    edge(5, 6),
    edge(3, 2),
  ]);
  expect(longestOpenChain(g)).toEqual([3, 2, 1, 5, 6]);
});

test('dagre places each issue below the issues it depends on, with a path for every edge', () => {
  const g = graph([
    issue(1, 'merged'),
    issue(2, 'waiting'),
    issue(3, 'waiting'),
    edge(2, 1),
    edge(3, 2),
  ]);
  const laid = layoutGraph(g);
  const y = (n: number) => laid.issues.find((i) => i.number === n)?.y ?? Number.NaN;
  expect(y(2)).toBeGreaterThanOrEqual(y(1) + NODE.height);
  expect(y(3)).toBeGreaterThanOrEqual(y(2) + NODE.height);
  expect(laid.dependencies.map((d) => [d.from, d.on])).toEqual([
    [2, 1],
    [3, 2],
  ]);
  for (const d of laid.dependencies) expect(d.d).toMatch(/^M[\d.]+,[\d.]+( L[\d.]+,[\d.]+)+$/);
  expect(laid.width).toBeGreaterThanOrEqual(NODE.width);
  expect(laid.height).toBeGreaterThanOrEqual(3 * NODE.height);
});
