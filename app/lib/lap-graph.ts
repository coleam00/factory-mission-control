/**
 * A lap drawn as a graph of its steps: the loop at the lap's own pin, laid out as the home map lays
 * it out (`homeMap`, `layoutSteps`), each step marked by what happened to it in this lap. Also the
 * lane's one-line version: the loop's top-level steps as marks. Pure, no React.
 */
import {
  type FoldedSteps,
  foldSteps,
  type HomeMapRow,
  homeMap,
  type StepGraph,
  stepsCount,
  topBlocks,
} from './home-map';
import type { StepAttemptRow } from './one-lap';

/** A row of `db/queries/one-lap-map.sql`: one node of the loop's expanded tree at the lap's pin. */
export interface LapMapRow {
  pin: string;
  path: string;
  parent_path: string | null;
  position: number;
  step_id: string;
  kind: string;
  depends_on: string[] | null;
  when_condition?: string | null;
  trigger_rule?: string | null;
  detail_workflow: string;
  detail_path: string;
}

/** What happened to a step in this lap. */
export type StepState = 'finished' | 'running' | 'failed' | 'skipped' | 'not-reached';

export const STATE_LABEL: Record<StepState, string> = {
  finished: 'Finished',
  running: 'Running',
  failed: 'Failed',
  skipped: 'Skipped',
  'not-reached': 'Not reached',
};

/** The token a state's mark is drawn in (PRD 8.3): teal finished, blue running, red failed. */
export const STATE_TOKEN: Record<StepState, `--${string}`> = {
  finished: '--success',
  running: '--running',
  failed: '--error',
  skipped: '--text-secondary',
  'not-reached': '--text-secondary',
};

/** Archon names a nested step by its path joined with `__` (`ship__deliver__scope`). */
export const pathOf = (stepId: string) => stepId.split('__').join('/');

/**
 * The map path a lap's step id runs at. Archon names a loop group's body step `<group>.<step>`
 * (composing across nested groups: `rounds.review__scope`), the same name on every iteration, so
 * a dotted name is the pinned step it is an iteration of when the map has that step (#282).
 */
export function mapPathOf(stepId: string, known: ReadonlySet<string>): string {
  const path = pathOf(stepId);
  if (!path.includes('.') || known.has(path)) return path;
  const split = path.replaceAll('.', '/');
  return known.has(split) ? split : path;
}

const stateOfStatus = (status: string): StepState =>
  status === 'running'
    ? 'running'
    : status === 'failed'
      ? 'failed'
      : status === 'skipped'
        ? 'skipped'
        : status === 'completed'
          ? 'finished'
          : 'not-reached';

const startOf = (a: StepAttemptRow) => a.started_at?.getTime() ?? Number.NEGATIVE_INFINITY;

export interface LapStep {
  /** The step's path in the loop (`ship/deliver/scope`). */
  path: string;
  state: StepState;
  /** This step's own attempts, oldest first: an include's box has none when Archon sends none. */
  attempts: StepAttemptRow[];
  /** Whether the lap ran a step the map of its pin does not have. */
  offMap: boolean;
}

export interface LapGraph {
  graph: StepGraph;
  steps: Map<string, LapStep>;
  /** The pin whose map this is, null when no architecture is stored for any pin. */
  pin: string | null;
}

/**
 * The loop at the lap's pin with each step's state. A step the lap ran that the pin's map lacks
 * (a newer step on an older map, or no map at all) is added where its path puts it, after the
 * steps that started before it.
 */
export function lapGraph(map: readonly LapMapRow[], attempts: readonly StepAttemptRow[]): LapGraph {
  const rows: HomeMapRow[] = map.map((r) => ({
    role: r.parent_path === null ? 'step' : 'stage',
    workflow: 'archon-loop',
    path: r.path,
    parent_path: r.parent_path,
    position: r.position,
    step_id: r.step_id,
    kind: r.kind,
    depends_on: r.depends_on,
    when_condition: r.when_condition ?? null,
    trigger_rule: r.trigger_rule ?? null,
    detail_workflow: r.detail_workflow,
    detail_path: r.detail_path,
    lap_factory: null,
    laps: 0,
    is_current: false,
  }));
  const known = new Set(map.map((r) => r.path));
  // Every step id at its pinned path, resolved before the steps the map lacks are added.
  const pinned = new Set(known);
  const at = (stepId: string) => mapPathOf(stepId, pinned);
  const byStep = new Map<string, StepAttemptRow[]>();
  for (const a of [...attempts].sort((x, y) => startOf(x) - startOf(y))) {
    byStep.set(a.step_id, [...(byStep.get(a.step_id) ?? []), a]);
  }

  // Steps the map lacks, in the order they started: each joins its parent (made too if missing),
  // depending on the sibling that started just before it, as the loop ran them.
  const offMap = new Set<string>();
  const lastStarted = new Map<string | null, string>();
  let position = map.reduce((n, r) => Math.max(n, r.position), 0);
  const ordered = [...byStep.entries()].sort(([, a], [, b]) => startOf(a[0]) - startOf(b[0]));
  for (const [stepId] of ordered) {
    const parts = at(stepId).split('/');
    for (let depth = 1; depth <= parts.length; depth++) {
      const path = parts.slice(0, depth).join('/');
      const parent = depth === 1 ? null : parts.slice(0, depth - 1).join('/');
      const name = parts[depth - 1];
      if (!known.has(path)) {
        const previous = lastStarted.get(parent);
        position += 1;
        rows.push({
          role: parent === null ? 'step' : 'stage',
          workflow: 'archon-loop',
          path,
          parent_path: parent,
          position,
          step_id: name,
          kind: '',
          depends_on: previous === undefined || previous === name ? [] : [previous],
          detail_workflow: 'archon-loop',
          detail_path: path,
          lap_factory: null,
          laps: 0,
          is_current: false,
        });
        known.add(path);
        offMap.add(path);
      }
      if (lastStarted.get(parent) !== name) lastStarted.set(parent, name);
    }
  }

  const graph = homeMap(rows, []).loop;
  const children = graph.clusters;
  // Every iteration of a loop's step is an attempt of its one node, oldest first.
  const own = new Map<string, StepAttemptRow[]>();
  for (const [id, list] of byStep) own.set(at(id), [...(own.get(at(id)) ?? []), ...list]);
  for (const list of own.values()) list.sort((x, y) => startOf(x) - startOf(y));
  const steps = new Map<string, LapStep>();
  const stateOf = (path: string): StepState => {
    const done = steps.get(path);
    if (done) return done.state;
    const list = own.get(path) ?? [];
    const latest = list.at(-1);
    const inner = (children.get(path) ?? []).map(stateOf);
    let state: StepState = latest === undefined ? 'not-reached' : stateOfStatus(latest.status);
    // An include's box: Archon may send no event for it, and it is never done before what it holds.
    if (inner.includes('running')) state = 'running';
    else if (inner.includes('failed') && state !== 'running') state = 'failed';
    else if (latest === undefined && inner.some((s) => s === 'finished' || s === 'skipped')) {
      state = inner.every((s) => s === 'skipped') ? 'skipped' : 'finished';
    }
    steps.set(path, { path, state, attempts: list, offMap: offMap.has(path) });
    return state;
  };
  for (const node of graph.steps) stateOf(node.id);

  // A step the lap passed without running (the route or depth did not need it) is skipped, not
  // still ahead: a step after it has run. Everything inside a skipped box is skipped with it.
  const next = new Map<string, string[]>();
  for (const { from, to } of graph.edges) next.set(from, [...(next.get(from) ?? []), to]);
  const ran = (path: string) => steps.get(path)?.state !== 'not-reached';
  const passed = (start: string) => {
    const seen = new Set<string>();
    const stack = [...(next.get(start) ?? [])];
    while (stack.length > 0) {
      const at = stack.pop() as string;
      if (seen.has(at)) continue;
      seen.add(at);
      // A box's own members are inside it, not after it.
      if (!at.startsWith(`${start}/`) && ran(at)) return true;
      stack.push(...(next.get(at) ?? []));
    }
    return false;
  };
  const skipped = new Set(graph.steps.filter((n) => !ran(n.id) && passed(n.id)).map((n) => n.id));
  for (const node of graph.steps) {
    const inside = [...skipped].some((box) => node.id.startsWith(`${box}/`));
    const step = steps.get(node.id);
    if (step && step.state === 'not-reached' && (skipped.has(node.id) || inside)) {
      step.state = 'skipped';
    }
  }
  return { graph, steps, pin: map[0]?.pin ?? null };
}

/** The loop's top-level steps a lane shows, in loop order; build and ship are one mark. */
export const LANE_STEPS = [
  'pick',
  'claim',
  'build/ship',
  'subject',
  'briefs',
  'check-app',
  'evidence',
  'handoff',
  'review',
  'land',
  'deploy',
  'release',
] as const;

export interface LaneMark {
  step: string;
  state: StepState;
}

/**
 * A running lap's row of marks from lanes.sql's `steps` (`<step id> <status>`, oldest first): a
 * top-level step is running while it or any step under it runs. A top-level step the list does not
 * name that the lap ran is added at the end.
 */
export function laneMarks(steps: readonly string[] | null): LaneMark[] {
  const states = new Map<string, StepState[]>();
  const extra: string[] = [];
  for (const entry of steps ?? []) {
    const [id, status] = entry.split(' ');
    const top = id.split('__')[0];
    const mark = top === 'build' || top === 'ship' ? 'build/ship' : top;
    if (!(LANE_STEPS as readonly string[]).includes(mark) && !extra.includes(mark))
      extra.push(mark);
    states.set(mark, [...(states.get(mark) ?? []), stateOfStatus(status ?? '')]);
  }
  const marks: LaneMark[] = [...LANE_STEPS, ...extra].map((step) => {
    const seen = states.get(step) ?? [];
    const state: StepState = seen.includes('running')
      ? 'running'
      : seen.includes('failed')
        ? 'failed'
        : seen.includes('finished')
          ? 'finished'
          : seen.length > 0 && seen.every((s) => s === 'skipped')
            ? 'skipped'
            : 'not-reached';
    return { step, state };
  });
  // A step the lap went past without running (a later one has run) is skipped, not ahead.
  const last = marks.findLastIndex((m) => m.state !== 'not-reached');
  return marks.map((m, i) =>
    i < last && m.state === 'not-reached' ? { ...m, state: 'skipped' } : m,
  );
}

/**
 * The blocks a lap opens with: each top-level include or loop group the lap ran (running, failed
 * or done), so ship's own steps branch beside the spine; one it did not run stays one box.
 */
export const ranBlocks = (lap: LapGraph): string[] =>
  topBlocks(lap.graph).filter((block) =>
    ['running', 'failed', 'finished'].includes(lap.steps.get(block)?.state ?? 'not-reached'),
  );

/**
 * Folds every include or loop group into one box unless it is in `opened` (by default the lap's
 * `ranBlocks`): a complex lap shows ship's own steps, each block inside it one box, not its 68 steps. The box says how the block
 * stands in this lap: the step running or failed inside it, and how many of its steps are done.
 */
export function foldGraph(lap: LapGraph, opened: ReadonlySet<string>): FoldedSteps {
  const stateOf = (path: string) => lap.steps.get(path)?.state ?? 'not-reached';
  return foldSteps(lap.graph, opened, (block, inside) => {
    const n = inside.length;
    const state = stateOf(block);
    if (state === 'skipped') return [`skipped · ${stepsCount(n)}`];
    if (state === 'not-reached') return [`not run · ${stepsCount(n)}`];
    const done = inside.filter((s) => ['finished', 'skipped'].includes(stateOf(s.id))).length;
    const progress = `${done} of ${n} done`;
    const at = (wanted: StepState) => inside.filter((s) => stateOf(s.id) === wanted).at(-1);
    const step =
      state === 'running' ? at('running') : state === 'failed' ? at('failed') : undefined;
    return step === undefined
      ? [progress]
      : // The step and the block it sits in, short enough for the box: `review/code`.
        [
          `${state}: ${step.id
            .slice(block.length + 1)
            .split('/')
            .slice(-2)
            .join('/')}`,
          progress,
        ];
  });
}
