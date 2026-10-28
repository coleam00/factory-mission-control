import dagre, { type EdgeLabel, type GraphLabel, type NodeLabel } from '@dagrejs/dagre';
import { stepHref } from './step-detail';

/** One row of `db/queries/home-map.sql`: a workflow the map shows, or one of its steps. */
export interface HomeMapRow {
  role: 'input' | 'manager' | 'step' | 'stage';
  workflow: string;
  path: string | null;
  parent_path: string | null;
  position: number | null;
  step_id: string | null;
  kind: string | null;
  depends_on: string[] | null;
  /** The workflow that declares the step: an include's steps are steps of the workflow it includes. */
  detail_workflow: string;
  /** The step's path in `detail_workflow`. */
  detail_path: string | null;
  /** The factory whose laps `laps` counts; null on a step no factory has a lap on. */
  lap_factory: string | null;
  /** That factory's running runs of the workflow on the step or anywhere beneath it. */
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
  /** The step's path: unique in its workflow, and the key of its edges. */
  id: string;
  workflow: string;
  /** A step of the workflow itself, or one an include or loop group nests beneath another. */
  role: 'step' | 'stage';
  label: string;
  kind: string;
  href: string;
  /** The laps of the factory in the address on it now. */
  liveCount: number;
  /** Every shown factory with laps on it now, the factory in the address first, then by name. */
  factories: FactoryLaps[];
  /** Set on an include or loop group folded into one box: what it holds, and the lines it shows. */
  folded?: Fold;
}

/** A folded block: how many steps it holds at every depth, and the short lines its box shows. */
export interface Fold {
  steps: number;
  notes: string[];
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

/** One workflow's expanded tree. */
export interface StepGraph {
  /** In declaration order, each include or loop group followed by the steps it nests. */
  steps: StepNode[];
  /** Each step's `depends_on`, less every edge another path between the same steps implies. */
  edges: Edge[];
  /** The steps directly beneath each include or loop group, keyed by its path. */
  clusters: Map<string, string[]>;
}

export interface HomeMap {
  inputs: FrameNode[];
  manager: FrameNode[];
  loop: StepGraph;
  /** The steps of each input and manager workflow, keyed by its name. */
  workflows: Map<string, StepGraph>;
  outputs: FrameNode[];
}

type StepRow = HomeMapRow & { path: string; step_id: string; position: number };

const isStep = (row: HomeMapRow): row is StepRow =>
  row.path !== null && row.step_id !== null && row.position !== null;

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
 * Each step path of one workflow once, with the laps each shown factory has on it: the query
 * gives a row per factory with laps, including a factory the server's factories file does not
 * name, which the map does not show (PRD 11.6), as the switcher does not list it.
 */
function stepsByPath(
  rows: readonly StepRow[],
  shown: readonly string[],
): { row: StepRow; factories: FactoryLaps[] }[] {
  const byPath = new Map<string, { row: StepRow; factories: FactoryLaps[] }>();
  for (const row of rows) {
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

/** One workflow's steps and edges: a step's `depends_on` names its siblings, as Archon scopes it. */
function stepGraph(rows: readonly StepRow[], shown: readonly string[]): StepGraph {
  const nodes = stepsByPath(rows, shown);
  const edges: Edge[] = [];
  const clusters = new Map<string, string[]>();
  const paths = new Set(nodes.map((n) => n.row.path));
  for (const { row } of nodes) {
    const scope = row.parent_path === null ? '' : `${row.parent_path}/`;
    const deps = (row.depends_on ?? []).map((d) => `${scope}${d}`).filter((d) => paths.has(d));
    for (const dep of deps) edges.push({ from: dep, to: row.path });
    if (row.parent_path !== null) {
      clusters.set(row.parent_path, [...(clusters.get(row.parent_path) ?? []), row.path]);
      if (deps.length === 0) edges.push({ from: row.parent_path, to: row.path });
    }
  }
  return {
    steps: nodes.map(({ row, factories }) => ({
      id: row.path,
      workflow: row.workflow,
      role: row.parent_path === null ? 'step' : 'stage',
      label: row.step_id,
      kind: row.kind ?? '',
      href: stepHref(row.detail_workflow, row.detail_path ?? row.path),
      liveCount: factories.find((f) => f.current)?.laps ?? 0,
      factories,
    })),
    edges: reduceEdges(edges),
    clusters,
  };
}

/**
 * Turns the live rows into the map, counting the laps of the factories in `shown` (the server's
 * factories file); every part is empty when no architecture is stored.
 */
export function homeMap(rows: readonly HomeMapRow[], shown: readonly string[]): HomeMap {
  const steps = rows.filter(isStep);
  const loop = steps.filter((r) => r.role === 'step' || r.role === 'stage');
  if (loop.length === 0) {
    return {
      inputs: [],
      manager: [],
      loop: { steps: [], edges: [], clusters: new Map() },
      workflows: new Map(),
      outputs: [],
    };
  }
  const frame = (role: FrameNode['role'], label: string): FrameNode => ({
    id: `${role}:${label}`,
    role,
    label,
  });
  const named = (role: 'input' | 'manager') =>
    [...new Set(rows.filter((r) => r.role === role).map((r) => r.workflow))].sort();
  const graphs = (role: 'input' | 'manager') =>
    named(role).map(
      (name) =>
        [
          name,
          stepGraph(
            steps.filter((r) => r.workflow === name),
            shown,
          ),
        ] as const,
    );

  return {
    inputs: [
      ...FRAME_INPUTS_BEFORE.map((label) => frame('frame-input', label)),
      ...named('input').map((name) => frame('input', name)),
      ...FRAME_INPUTS_AFTER.map((label) => frame('frame-input', label)),
    ],
    manager: named('manager').map((name) => frame('manager', name)),
    loop: stepGraph(loop, shown),
    workflows: new Map([...graphs('input'), ...graphs('manager')]),
    outputs: FRAME_OUTPUTS.map((label) => frame('output', label)),
  };
}

export interface FoldedSteps {
  /** The graph with each folded block's steps taken out: the block is one box, `folded` set. */
  graph: StepGraph;
  /** Each folded block's path, and how many steps it holds at every depth. */
  folded: Map<string, number>;
  /** The steps the folded blocks hold, in the graph's order: in the page, hidden. */
  hidden: StepNode[];
}

export const stepsCount = (n: number) => `${n} ${n === 1 ? 'step' : 'steps'}`;

/**
 * Folds every include or loop group the viewer has not opened into one box, so a workflow opens
 * as its top-level steps only. Opening a block shows its own steps; a block inside it stays folded
 * until opened in turn. `notes` gives a folded block's lines; by default its step count.
 */
export function foldSteps(
  graph: StepGraph,
  opened: ReadonlySet<string>,
  notes: (block: string, inside: StepNode[]) => string[] = (_, inside) => [
    stepsCount(inside.length),
  ],
): FoldedSteps {
  const inside = (block: string) => graph.steps.filter((s) => s.id.startsWith(`${block}/`));
  const folded = new Map<string, number>();
  for (const block of graph.clusters.keys()) {
    if (opened.has(block)) continue;
    if ([...folded.keys()].some((outer) => block.startsWith(`${outer}/`))) continue;
    folded.set(block, inside(block).length);
    // A block folded inside one now folded is gone with it.
    for (const inner of [...folded.keys()]) {
      if (inner.startsWith(`${block}/`)) folded.delete(inner);
    }
  }
  if (folded.size === 0) return { graph, folded, hidden: [] };
  const isHidden = (id: string) => [...folded.keys()].some((block) => id.startsWith(`${block}/`));
  return {
    graph: {
      steps: graph.steps
        .filter((s) => !isHidden(s.id))
        .map((s) => {
          const steps = folded.get(s.id);
          return steps === undefined
            ? s
            : { ...s, folded: { steps, notes: notes(s.id, inside(s.id)) } };
        }),
      edges: graph.edges.filter((e) => !isHidden(e.from) && !isHidden(e.to)),
      clusters: new Map(
        [...graph.clusters].filter(([block]) => !folded.has(block) && !isHidden(block)),
      ),
    },
    folded,
    hidden: graph.steps.filter((s) => isHidden(s.id)),
  };
}

/** The block a folded graph shows in place of `path`: the step itself, or the folded box it is in. */
export function shownAs(folded: ReadonlyMap<string, number>, path: string): string {
  for (const block of folded.keys()) if (path.startsWith(`${block}/`)) return block;
  return path;
}

const NODE_W = 168;
const NODE_H = 46;
/** The 13px Geist Mono label's advance per character, rounded up so a name never clips. */
const CHAR_W = 8;
/** Room a step's box keeps beside its label: padding, kind glyph, gaps, live dot and count. */
const LABEL_RESERVE = 96;
/** The longest name kept on one line; a longer one breaks onto two. */
const ONE_LINE_MAX = 16;
/** Each label line past the first adds this much height. */
const LINE_H = 17;
/** A folded block's note line: 11px Geist Mono, its advance per character rounded up. */
const NOTE_H = 15;
const NOTE_CHAR_W = 7;

/**
 * A step's name as the lines its box shows, in full: one line up to ONE_LINE_MAX characters,
 * otherwise two, split after the `-`, `_`, `.` or `/` that leaves the longer line shortest. A
 * name with no such separator stays on one line and its box widens to fit it.
 */
export function stepLabelLines(label: string): string[] {
  if (label.length <= ONE_LINE_MAX) return [label];
  let best: number | null = null;
  for (let i = 1; i < label.length; i++) {
    if (!'-_./'.includes(label[i - 1] ?? '')) continue;
    if (best === null || Math.max(i, label.length - i) < Math.max(best, label.length - best)) {
      best = i;
    }
  }
  return best === null ? [label] : [label.slice(0, best), label.slice(best)];
}
const MARGIN = 24;
const CLUSTER_PAD = 16;

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Point {
  x: number;
  y: number;
}

export interface StepLayout {
  nodes: Map<string, Box>;
  /** The box around each include or loop group: its own step at the top, then the steps it nests. */
  clusters: Map<string, Box>;
  edges: (Edge & { d: string })[];
  width: number;
  height: number;
}

interface Level {
  nodes: Map<string, Box>;
  clusters: Map<string, Box>;
  edges: (Edge & { points: Point[] })[];
  width: number;
  height: number;
}

const shifted = <T extends Point>(p: T, by: Point): T => ({ ...p, x: p.x + by.x, y: p.y + by.y });

/**
 * A step's box: wide enough for its whole name (on one line or two, as stepLabelLines splits it),
 * and one 15px line per factory below the label when another factory has laps on it. Dagre gets
 * the full size, so edges and siblings clear the name and the counts.
 */
function stepSize(node: StepNode): { width: number; height: number } {
  const lines = stepLabelLines(node.label);
  const notes = node.folded?.notes ?? [];
  const name = Math.max(
    LABEL_RESERVE + Math.max(...lines.map((line) => line.length)) * CHAR_W,
    ...notes.map((note) => LABEL_RESERVE + note.length * NOTE_CHAR_W),
  );
  const height = NODE_H + (lines.length - 1) * LINE_H + notes.length * NOTE_H;
  if (!node.factories.some((f) => !f.current)) return { width: Math.max(NODE_W, name), height };
  // Reserve 70px horizontally for the padding, glyph, gaps and live dot; 7px per character leaves
  // room for 10px Geist Mono.
  return {
    width: Math.max(
      NODE_W,
      name,
      ...node.factories.map((f) => 70 + `${f.factory} ${f.laps}`.length * 7),
    ),
    height: height + node.factories.length * 15,
  };
}

/**
 * Lays a workflow out top to bottom with dagre, innermost first: each include or loop group is
 * laid out on its own, its step on top, and placed in its parent's layout as one box of that size.
 * Every nested step sits inside each box around it, and the spine keeps its order past the boxes.
 */
export function layoutSteps(graph: StepGraph, narrow = false): StepLayout {
  const byId = new Map(graph.steps.map((s) => [s.id, s]));
  const nested = new Set([...graph.clusters.values()].flat());

  const level = (parent: string | null): Level => {
    const members =
      parent === null
        ? graph.steps.filter((s) => !nested.has(s.id)).map((s) => s.id)
        : (graph.clusters.get(parent) ?? []);
    const local = parent === null ? members : [parent, ...members];
    const margin = parent === null ? MARGIN : CLUSTER_PAD;
    const g = new dagre.graphlib.Graph<GraphLabel, NodeLabel, EdgeLabel>();
    g.setDefaultEdgeLabel(() => ({}));
    g.setGraph({ rankdir: 'TB', ranksep: 36, nodesep: 28, marginx: margin, marginy: margin });
    const blocks = new Map<string, Level>();
    for (const id of local) {
      const block = id !== parent && graph.clusters.has(id) ? level(id) : undefined;
      if (block) blocks.set(id, block);
      g.setNode(id, block ?? stepSize(byId.get(id) as StepNode));
    }
    const edges = graph.edges.filter((e) => local.includes(e.from) && local.includes(e.to));
    for (const edge of edges) g.setEdge(edge.from, edge.to);
    dagre.layout(g);

    const outer = new Map(
      local.map((id): [string, Box] => {
        const { x = 0, y = 0, width, height } = g.node(id);
        return [id, { x: x - width / 2, y: y - height / 2, width, height }];
      }),
    );
    // The desktop spine bends around the boxes. On a phone keep every spine node, and each box
    // with everything in it, in the first column; a wide box scrolls sideways at full size.
    const column = narrow && parent === null;
    if (column) for (const box of outer.values()) box.x = MARGIN;

    const laid: Level = { nodes: new Map(), clusters: new Map(), edges: [], width: 0, height: 0 };
    for (const [id, box] of outer) {
      const block = blocks.get(id);
      if (block === undefined) {
        laid.nodes.set(id, box);
        continue;
      }
      laid.clusters.set(id, box);
      for (const [k, b] of block.nodes) laid.nodes.set(k, shifted(b, box));
      for (const [k, b] of block.clusters) laid.clusters.set(k, shifted(b, box));
      for (const e of block.edges) {
        laid.edges.push({ ...e, points: e.points.map((p) => shifted(p, box)) });
      }
    }
    for (const edge of edges) {
      const from = outer.get(edge.from) as Box;
      const to = outer.get(edge.to) as Box;
      const x1 = from.x + from.width / 2;
      const y1 = from.y + from.height;
      const x2 = to.x + to.width / 2;
      const y2 = to.y;
      const mid = (y1 + y2) / 2;
      const points = column
        ? [
            { x: x1, y: y1 },
            { x: x1, y: mid },
            { x: x2, y: mid },
            { x: x2, y: y2 },
          ]
        : (g.edge(edge.from, edge.to).points ?? []);
      laid.edges.push({ ...edge, points });
    }
    const size = g.graph();
    laid.width = size.width ?? 0;
    laid.height = size.height ?? 0;
    return laid;
  };

  const top = level(null);
  return {
    nodes: new Map(graph.steps.map((s) => [s.id, top.nodes.get(s.id) as Box])),
    clusters: top.clusters,
    edges: top.edges.map(({ points, ...edge }) => ({
      ...edge,
      d: points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' '),
    })),
    width: top.width,
    height: top.height,
  };
}
