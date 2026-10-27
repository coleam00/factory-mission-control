import dagre, { type EdgeLabel, type GraphLabel, type NodeLabel } from '@dagrejs/dagre';
import { stepHref } from './step-detail';

/** One row of `db/queries/home-map.sql`: a workflow the map shows, or one of the loop's steps. */
export interface HomeMapRow {
  role: 'input' | 'manager' | 'step' | 'stage';
  workflow: string;
  path: string | null;
  parent_path: string | null;
  position: number | null;
  step_id: string | null;
  kind: string | null;
  depends_on: string[] | null;
  /** The workflow whose step this is: a stage is a step of the workflow its parent includes. */
  detail_workflow: string;
  /** The factory whose laps `laps` counts; null on a step no factory has a lap on. */
  lap_factory: string | null;
  /** That factory's running laps on the step or anywhere beneath it. */
  laps: number;
  /** Whether `lap_factory` is the factory in the address. */
  is_current: boolean;
}

/**
 * What flows into and out of the factory without being a workflow of the pack (PRD 4.1). The
 * architecture rows hold workflows and steps only, so these are the map's frame.
 */
const FRAME_INPUTS_BEFORE = ['Product document'];
const FRAME_INPUTS_AFTER = ['Owner decisions'];
const FRAME_OUTPUTS = [
  'Merged pull requests',
  'Closed issues',
  'Deploys',
  'Owner questions',
  'Metrics lines',
];

/** An input, the manager or an output: a workflow of the pack, or a fixed part of the frame. */
export interface FrameNode {
  id: string;
  role: 'frame-input' | 'input' | 'manager' | 'output';
  label: string;
}

export interface StepNode {
  /** The step's path: unique in the loop, and the key of its edges. */
  id: string;
  role: 'step' | 'stage';
  label: string;
  kind: string;
  href: string;
  /** The laps of the factory in the address on it now. */
  liveCount: number;
  /** Every shown factory with laps on it now, the factory in the address first, then by name. */
  factories: FactoryLaps[];
}

export interface FactoryLaps {
  factory: string;
  laps: number;
  current: boolean;
}

export interface Edge {
  from: string;
  to: string;
}

export interface HomeMap {
  inputs: FrameNode[];
  manager: FrameNode[];
  /** The loop's steps in declaration order, each expanded step followed by its stages. */
  loop: StepNode[];
  outputs: FrameNode[];
  /** Each step's `depends_on`, less every edge another path between the same steps implies. */
  edges: Edge[];
  /** The stages of each expanded step, keyed by that step's path. */
  clusters: Map<string, string[]>;
}

type StepRow = HomeMapRow & { path: string; step_id: string; position: number };

const isStep = (row: HomeMapRow): row is StepRow =>
  (row.role === 'step' || row.role === 'stage') &&
  row.path !== null &&
  row.step_id !== null &&
  row.position !== null;

/** Drops every edge whose target its source also reaches through another step. */
export function reduceEdges(edges: readonly Edge[]): Edge[] {
  const next = new Map<string, string[]>();
  for (const { from, to } of edges) next.set(from, [...(next.get(from) ?? []), to]);
  const reachesAvoiding = (start: string, goal: string, skip: Edge): boolean => {
    const seen = new Set<string>();
    const stack = [start];
    while (stack.length > 0) {
      const at = stack.pop() as string;
      for (const to of next.get(at) ?? []) {
        if (at === skip.from && to === skip.to) continue;
        if (to === goal) return true;
        if (!seen.has(to)) {
          seen.add(to);
          stack.push(to);
        }
      }
    }
    return false;
  };
  return edges.filter((edge) => !reachesAvoiding(edge.from, edge.to, edge));
}

/**
 * Each step path once, with the laps each shown factory has on it: the query gives a row per
 * factory with laps, including a factory the server's factories file does not name, which the map
 * does not show (PRD 11.6), as the switcher does not list it.
 */
function stepsByPath(
  rows: readonly HomeMapRow[],
  shown: readonly string[],
): { row: StepRow; factories: FactoryLaps[] }[] {
  const byPath = new Map<string, { row: StepRow; factories: FactoryLaps[] }>();
  for (const row of rows.filter(isStep)) {
    const step = byPath.get(row.path) ?? { row, factories: [] };
    byPath.set(row.path, step);
    if (row.lap_factory !== null && shown.includes(row.lap_factory)) {
      step.factories.push({ factory: row.lap_factory, laps: row.laps, current: row.is_current });
    }
  }
  for (const { factories } of byPath.values()) {
    factories.sort(
      (a, b) => Number(b.current) - Number(a.current) || a.factory.localeCompare(b.factory),
    );
  }
  return [...byPath.values()].sort((a, b) => a.row.position - b.row.position);
}

/**
 * Turns the live rows into the map, counting the laps of the factories in `shown` (the server's
 * factories file); every part is empty when no architecture is stored.
 */
export function homeMap(rows: readonly HomeMapRow[], shown: readonly string[]): HomeMap {
  const nodes = stepsByPath(rows, shown);
  const steps = nodes.map((n) => n.row);
  if (steps.length === 0) {
    return { inputs: [], manager: [], loop: [], outputs: [], edges: [], clusters: new Map() };
  }
  const frame = (role: FrameNode['role'], label: string): FrameNode => ({
    id: `${role}:${label}`,
    role,
    label,
  });
  const workflows = (role: 'input' | 'manager') =>
    rows
      .filter((r) => r.role === role)
      .map((r) => r.workflow)
      .sort()
      .map((name) => frame(role, name));

  const edges: Edge[] = [];
  const clusters = new Map<string, string[]>();
  const paths = new Set(steps.map((s) => s.path));
  for (const step of steps) {
    const scope = step.parent_path === null ? '' : `${step.parent_path}/`;
    const deps = (step.depends_on ?? []).map((d) => `${scope}${d}`).filter((d) => paths.has(d));
    for (const dep of deps) edges.push({ from: dep, to: step.path });
    if (step.parent_path !== null) {
      clusters.set(step.parent_path, [...(clusters.get(step.parent_path) ?? []), step.path]);
      if (deps.length === 0) edges.push({ from: step.parent_path, to: step.path });
    }
  }

  return {
    inputs: [
      ...FRAME_INPUTS_BEFORE.map((label) => frame('frame-input', label)),
      ...workflows('input'),
      ...FRAME_INPUTS_AFTER.map((label) => frame('frame-input', label)),
    ],
    manager: workflows('manager'),
    loop: nodes.map(({ row, factories }) => ({
      id: row.path,
      role: row.role as StepNode['role'],
      label: row.step_id,
      kind: row.kind ?? '',
      href: stepHref(row.detail_workflow, row.step_id),
      liveCount: factories.find((f) => f.current)?.laps ?? 0,
      factories,
    })),
    outputs: FRAME_OUTPUTS.map((label) => frame('output', label)),
    edges: reduceEdges(edges),
    clusters,
  };
}

const NODE_W = 168;
const NODE_H = 46;
const CLUSTER_PAD = 16;

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LoopLayout {
  nodes: Map<string, Box>;
  clusters: Map<string, Box>;
  edges: (Edge & { d: string })[];
  width: number;
  height: number;
}

/** Lays the loop out top to bottom with dagre, each expanded step's stages in a box. */
export function layoutLoop(map: HomeMap, narrow = false): LoopLayout {
  const g = new dagre.graphlib.Graph<GraphLabel, NodeLabel, EdgeLabel>({ compound: true });
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: 'TB', ranksep: 36, nodesep: 28, marginx: 24, marginy: 24 });
  for (const node of map.loop) {
    const labelled = node.factories.some((f) => !f.current);
    // One 15px line per factory, below the step label. Reserve 70px horizontally for the
    // padding, glyph, gaps and live dot; 7px per character leaves room for 10px Geist Mono.
    // Give dagre the full size so edges, siblings and stage clusters also clear the counts.
    g.setNode(node.id, {
      width: labelled
        ? Math.max(NODE_W, ...node.factories.map((f) => 70 + `${f.factory} ${f.laps}`.length * 7))
        : NODE_W,
      height: labelled ? NODE_H + node.factories.length * 15 : NODE_H,
    });
  }
  for (const [parent, members] of map.clusters) {
    const cluster = `cluster:${parent}`;
    g.setNode(cluster, {
      width: 0,
      height: 0,
      paddingLeft: CLUSTER_PAD,
      paddingRight: CLUSTER_PAD,
    });
    for (const member of members) g.setParent(member, cluster);
  }
  for (const edge of map.edges) g.setEdge(edge.from, edge.to);
  dagre.layout(g);

  const boxOf = (id: string): Box => {
    const { x = 0, y = 0, width, height } = g.node(id);
    return { x: x - width / 2, y: y - height / 2, width, height };
  };
  const nodes = new Map(map.loop.map((node) => [node.id, boxOf(node.id)]));
  // The desktop spine bends around expanded stages. On a phone keep every spine node
  // in the first column, leaving the expanded stages reachable beside it at full size.
  if (narrow) {
    for (const node of map.loop) {
      const box = nodes.get(node.id);
      if (node.role === 'step' && box) box.x = 24;
    }
  }
  const clusters = new Map([...map.clusters.keys()].map((p) => [p, boxOf(`cluster:${p}`)]));
  const edges = map.edges.map((edge) => {
    const from = nodes.get(edge.from);
    const to = nodes.get(edge.to);
    if (narrow && from && to) {
      const x1 = from.x + from.width / 2;
      const y1 = from.y + from.height;
      const x2 = to.x + to.width / 2;
      const y2 = to.y;
      return { ...edge, d: `M${x1},${y1} V${(y1 + y2) / 2} H${x2} V${y2}` };
    }
    const points = g.edge(edge.from, edge.to).points ?? [];
    return { ...edge, d: points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ') };
  });
  const graph = g.graph();
  return { nodes, clusters, edges, width: graph.width ?? 0, height: graph.height ?? 0 };
}
