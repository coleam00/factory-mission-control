/**
 * The issues screen's rows, as `db/queries/issue-graph.sql` returns them: one row per issue with
 * the state the query derived, and one per `Depends on: #n` edge. Pure, no React.
 */
import dagre, { type EdgeLabel, type GraphLabel, type NodeLabel } from '@dagrejs/dagre';

export const ISSUE_STATES = [
  'waiting',
  'claimed',
  'pr-open',
  'needs-owner',
  'merged',
  'closed',
] as const;

export type IssueState = (typeof ISSUE_STATES)[number];

const CLOSED_STATES: ReadonlySet<IssueState> = new Set(['merged', 'closed']);

interface IssueRow {
  kind: 'issue';
  number: number;
  title: string;
  phase: string | null;
  url: string;
  state: IssueState;
  depends_on: null;
}

/** Issue `number` depends on issue `depends_on`. */
interface EdgeRow {
  kind: 'edge';
  number: number;
  title: null;
  phase: null;
  url: null;
  state: null;
  depends_on: number;
}

export type IssueGraphRow = IssueRow | EdgeRow;

export interface Issue {
  number: number;
  title: string;
  phase: string | null;
  url: string;
  state: IssueState;
}

export interface Dependency {
  from: number;
  on: number;
}

export interface IssueGraph {
  /** By number, ascending. */
  issues: Issue[];
  /** Only edges between two issues this factory has. */
  dependencies: Dependency[];
}

export function issueGraph(rows: readonly IssueGraphRow[]): IssueGraph {
  const issues: Issue[] = [];
  const edges: Dependency[] = [];
  for (const row of rows) {
    if (row.kind === 'issue') {
      const { number, title, phase, url, state } = row;
      issues.push({ number, title, phase, url, state });
    } else {
      edges.push({ from: row.number, on: row.depends_on });
    }
  }
  const known = new Set(issues.map((i) => i.number));
  return {
    issues: issues.sort((a, b) => a.number - b.number),
    dependencies: edges
      .filter((e) => known.has(e.from) && known.has(e.on))
      .sort((a, b) => a.from - b.from || a.on - b.on),
  };
}

export interface PhaseBar {
  phase: string;
  merged: number;
  total: number;
}

/** One bar per product-document phase, in the order of each phase's first issue. */
export function phaseBars(issues: readonly Issue[]): PhaseBar[] {
  const bars = new Map<string, PhaseBar>();
  for (const issue of issues) {
    if (issue.phase === null) continue;
    const bar = bars.get(issue.phase) ?? { phase: issue.phase, merged: 0, total: 0 };
    bar.total += 1;
    if (issue.state === 'merged') bar.merged += 1;
    bars.set(issue.phase, bar);
  }
  return [...bars.values()];
}

/**
 * The longest chain of open issues each depending on the next, from the dependent end, or empty
 * when no open issue depends on another open one. Ties go to the lower issue numbers. A cycle in
 * the `Depends on` lines is cut where it closes rather than followed.
 */
export function longestOpenChain({ issues, dependencies }: IssueGraph): number[] {
  const open = new Set(issues.filter((i) => !CLOSED_STATES.has(i.state)).map((i) => i.number));
  const dependsOn = new Map<number, number[]>();
  for (const { from, on } of dependencies) {
    if (open.has(from) && open.has(on)) dependsOn.set(from, [...(dependsOn.get(from) ?? []), on]);
  }
  const chains = new Map<number, number[]>();
  const visiting = new Set<number>();
  const chainFrom = (number: number): number[] => {
    const known = chains.get(number);
    if (known) return known;
    visiting.add(number);
    let longest: number[] = [];
    for (const next of dependsOn.get(number) ?? []) {
      if (visiting.has(next)) continue;
      const chain = chainFrom(next);
      if (chain.length > longest.length) longest = chain;
    }
    visiting.delete(number);
    const chain = [number, ...longest];
    chains.set(number, chain);
    return chain;
  };
  let longest: number[] = [];
  for (const number of [...open].sort((a, b) => a - b)) {
    const chain = chainFrom(number);
    if (chain.length > longest.length) longest = chain;
  }
  return longest.length >= 2 ? longest : [];
}

export const NODE = { width: 184, height: 58 };

export interface PlacedIssue extends Issue {
  /** Top left, in px. */
  x: number;
  y: number;
}

export interface PlacedDependency extends Dependency {
  /** An SVG path from the depended-on issue down to the dependent, routed by dagre. */
  d: string;
}

export interface GraphLayout {
  issues: PlacedIssue[];
  dependencies: PlacedDependency[];
  width: number;
  height: number;
}

/** Laid out top to bottom with dagre: an issue sits below the issues it depends on. */
export function layoutGraph({ issues, dependencies }: IssueGraph): GraphLayout {
  const g = new dagre.graphlib.Graph<GraphLabel, NodeLabel, EdgeLabel>();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: 'TB', ranksep: 48, nodesep: 20, marginx: 16, marginy: 16 });
  for (const issue of issues) g.setNode(String(issue.number), { ...NODE });
  for (const { from, on } of dependencies) g.setEdge(String(on), String(from));
  dagre.layout(g);

  const placed = issues.map((issue) => {
    const { x = 0, y = 0 } = g.node(String(issue.number));
    return { ...issue, x: x - NODE.width / 2, y: y - NODE.height / 2 };
  });
  return {
    issues: placed,
    dependencies: dependencies.map((dep) => {
      const points = g.edge(String(dep.on), String(dep.from)).points ?? [];
      return {
        ...dep,
        d: points.map(({ x, y }, i) => `${i === 0 ? 'M' : 'L'}${x},${y}`).join(' '),
      };
    }),
    width: g.graph().width ?? 0,
    height: g.graph().height ?? 0,
  };
}
