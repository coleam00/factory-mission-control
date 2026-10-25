import dagre, { type EdgeLabel, type GraphLabel, type NodeLabel } from '@dagrejs/dagre';

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
  live_count: number;
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
  liveCount: number;
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

/** Turns the live rows into the map; every part is empty when no architecture is stored. */
export function homeMap(rows: readonly HomeMapRow[]): HomeMap {
  const steps = rows.filter(isStep).sort((a, b) => a.position - b.position);
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
    loop: steps.map((row) => ({
      id: row.path,
      role: row.role as StepNode['role'],
      label: row.step_id,
      kind: row.kind ?? '',
      href: `/steps/${encodeURIComponent(row.detail_workflow)}/${encodeURIComponent(row.step_id)}`,
      liveCount: row.live_count,
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
export function layoutLoop(map: HomeMap): LoopLayout {
  const g = new dagre.graphlib.Graph<GraphLabel, NodeLabel, EdgeLabel>({ compound: true });
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: 'TB', ranksep: 36, nodesep: 28, marginx: 24, marginy: 24 });
  for (const node of map.loop) g.setNode(node.id, { width: NODE_W, height: NODE_H });
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
  const clusters = new Map([...map.clusters.keys()].map((p) => [p, boxOf(`cluster:${p}`)]));
  const edges = map.edges.map((edge) => {
    const points = g.edge(edge.from, edge.to).points ?? [];
    return { ...edge, d: points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ') };
  });
  const graph = g.graph();
  return { nodes, clusters, edges, width: graph.width ?? 0, height: graph.height ?? 0 };
}
