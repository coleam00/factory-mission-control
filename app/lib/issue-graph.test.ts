import { expect, test } from 'bun:test';
import {
  type IssueGraph,
  type IssueGraphRow,
  type IssueState,
  issueGraph,
  issueView,
  layoutPhases,
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

/** The seed's shape: three phases, a merged trunk, an open chain on top of it, two unphased. */
const seed = graph([
  issue(1, 'merged', 'Skeleton'),
  issue(2, 'merged', 'Skeleton'),
  issue(3, 'closed', 'Skeleton'),
  issue(4, 'merged', 'Schema'),
  issue(5, 'merged', 'Schema'),
  issue(6, 'pr-open', 'Schema'),
  issue(7, 'claimed', 'Screens'),
  issue(8, 'needs-owner', 'Screens'),
  issue(9, 'waiting', 'Screens'),
  issue(10, 'waiting', null),
  edge(2, 1),
  edge(4, 2),
  edge(5, 4),
  edge(6, 5),
  edge(7, 6),
  edge(8, 6),
  edge(9, 8),
  edge(10, 1),
]);

test('by default only open issues and what they directly depend on are drawn', () => {
  const view = issueView(seed);
  expect(view.issues.map((i) => [i.number, i.context])).toEqual([
    [1, true],
    [5, true],
    [6, false],
    [7, false],
    [8, false],
    [9, false],
    [10, false],
  ]);
  expect(view.dependencies).toEqual([
    { from: 6, on: 5 },
    { from: 7, on: 6 },
    { from: 8, on: 6 },
    { from: 9, on: 8 },
    { from: 10, on: 1 },
  ]);
  expect(view.hidden).toBe(0);
});

test('merged and closed issues collapse into counts per phase, phases in order, No phase last', () => {
  expect(issueView(seed).columns).toEqual([
    { phase: 'Skeleton', open: 0, merged: 2, closed: 1 },
    { phase: 'Schema', open: 1, merged: 2, closed: 0 },
    { phase: 'Screens', open: 3, merged: 0, closed: 0 },
    { phase: null, open: 1, merged: 0, closed: 0 },
  ]);
});

test('Show merged draws every issue and every edge again', () => {
  const view = issueView(seed, { showMerged: true });
  expect(view.issues).toHaveLength(10);
  expect(view.dependencies).toHaveLength(seed.dependencies.length);
  expect(view.issues.every((i) => !i.context)).toBe(true);
});

test('past the cap the open issues closest to merge stay, and the rest are counted', () => {
  const rows = [
    ...Array.from({ length: 30 }, (_, n) => issue(n + 1, 'waiting')),
    issue(31, 'claimed'),
    issue(32, 'pr-open'),
    issue(33, 'merged'),
    edge(32, 33),
  ];
  const view = issueView(graph(rows), { cap: 10 });
  expect(view.issues.map((i) => i.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 31, 32, 33]);
  expect(view.hidden).toBe(23);
});

test('a factory with no phases and mostly merged work: its open issues under No phase', () => {
  // north-star: an older pack, no phase on any issue, nearly everything merged.
  const rows = [
    ...Array.from({ length: 40 }, (_, n) => issue(n + 1, 'merged', null)),
    issue(41, 'waiting', null),
    issue(42, 'claimed', null),
    edge(42, 40),
  ];
  const view = issueView(graph(rows));
  expect(view.columns).toEqual([{ phase: null, open: 2, merged: 40, closed: 0 }]);
  expect(view.issues.map((i) => i.number)).toEqual([40, 41, 42]);
  const laid = layoutPhases(view, 1104);
  expect(laid.columns).toHaveLength(1);
  expect(laid.overflows).toBe(false);
  expect(laid.issues).toHaveLength(3);
});

test('every edge runs down: an issue sits in a band below everything it depends on', () => {
  for (const showMerged of [false, true]) {
    const laid = layoutPhases(issueView(seed, { showMerged }), 1104);
    const at = new Map(laid.issues.map((i) => [i.number, i]));
    for (const { from, on } of laid.dependencies) {
      expect(at.get(from)?.y ?? 0).toBeGreaterThan((at.get(on)?.y ?? 0) + NODE.height);
    }
    for (const d of laid.dependencies) expect(d.d).toMatch(/^M[\d.]+,[\d.]+ [CL]/);
  }
});

test('each issue sits inside its phase column, and the columns fit the width given', () => {
  const laid = layoutPhases(issueView(seed, { showMerged: true }), 1104);
  expect(laid.columns.map((c) => c.phase)).toEqual(['Skeleton', 'Schema', 'Screens', null]);
  expect(laid.width).toBeLessThanOrEqual(1104);
  expect(laid.overflows).toBe(false);
  for (const i of laid.issues) {
    const column = laid.columns.find((c) => c.phase === i.phase);
    expect(i.x).toBeGreaterThanOrEqual(column?.x ?? Number.NaN);
    expect(i.x + i.width).toBeLessThanOrEqual((column?.x ?? 0) + (column?.width ?? 0));
  }
});

test('a wide band wraps inside its column rather than widening the screen', () => {
  const rows = Array.from({ length: 30 }, (_, n) => issue(n + 1, 'waiting', 'Screens'));
  const laid = layoutPhases(issueView(graph(rows)), 900);
  expect(laid.overflows).toBe(false);
  expect(laid.width).toBeLessThanOrEqual(900);
  expect(new Set(laid.issues.map((i) => i.y)).size).toBeGreaterThan(1);
});

/** Points along an SVG path made of M, L, Q and C commands, as the screen draws it. */
function along(d: string): [number, number][] {
  const points: [number, number][] = [];
  let at: [number, number] = [0, 0];
  for (const [, op, args] of d.matchAll(/([MLQC])([^MLQC]*)/g)) {
    const n = args.trim().split(/[ ,]+/).map(Number);
    const pts: [number, number][] = [];
    for (let i = 0; i < n.length; i += 2) pts.push([n[i], n[i + 1]]);
    const bez = (ctrl: [number, number][], t: number): [number, number] => {
      let ps = [at, ...ctrl];
      while (ps.length > 1)
        ps = ps
          .slice(1)
          .map((q, i) => [ps[i][0] + (q[0] - ps[i][0]) * t, ps[i][1] + (q[1] - ps[i][1]) * t]);
      return ps[0];
    };
    if (op !== 'M') for (let s = 1; s <= 20; s++) points.push(bez(pts, s / 20));
    at = pts[pts.length - 1];
  }
  return points;
}

function edgesOverIssues(layout: ReturnType<typeof layoutPhases>): string[] {
  const over: string[] = [];
  for (const dep of layout.dependencies) {
    for (const issue of layout.issues) {
      if (issue.number === dep.from || issue.number === dep.on) continue;
      const hit = along(dep.d).some(
        ([x, y]) =>
          x > issue.x && x < issue.x + issue.width && y > issue.y && y < issue.y + NODE.height,
      );
      if (hit) over.push(`${dep.from}-${dep.on} over #${issue.number}`);
    }
  }
  return over;
}

test('no edge runs over an issue it does not join, even where a band wraps', () => {
  // A band of eight in one phase, in a width that fits three: it wraps into three lines.
  const rows = [
    issue(1, 'merged', 'Screens'),
    ...Array.from({ length: 8 }, (_, n) => issue(n + 2, 'waiting', 'Screens')),
    issue(20, 'waiting', 'Screens'),
    issue(21, 'waiting', 'Live'),
    ...Array.from({ length: 8 }, (_, n) => edge(n + 2, 1)),
    edge(20, 9),
    edge(21, 2),
  ];
  for (const width of [560, 900, 1840]) {
    const laid = layoutPhases(issueView(graph(rows)), width);
    expect(laid.overflows).toBe(false);
    expect(edgesOverIssues(laid)).toEqual([]);
  }
  for (const showMerged of [false, true]) {
    expect(edgesOverIssues(layoutPhases(issueView(seed, { showMerged }), 1104))).toEqual([]);
  }
});
