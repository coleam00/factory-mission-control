import { type ReactElement, type ReactNode, useMemo, useState, useSyncExternalStore } from 'react';
import { Link } from 'react-router';
import {
  type Box,
  type FrameNode,
  foldSteps,
  type HomeMapRow,
  homeMap,
  layoutSteps,
  openedBlocks,
  type StepGraph,
  type StepNode,
  stepLabelLines,
  topBlocks,
} from '../lib/home-map';
import { LiveDot } from './LiveDot';
import { GraphViewport } from './GraphViewport';

const narrowScreen = () => window.matchMedia('(max-width: 639px)').matches;
const subscribeScreen = (onChange: () => void) => {
  const query = window.matchMedia('(max-width: 639px)');
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
};

/** Kind glyphs from the console's run graph (RunGraphPanel); an include gets a boxed square. */
const KIND_GLYPH: Record<string, string> = {
  loop: '↻',
  loop_group: '↻',
  approval: '◈',
  bash: '$',
  command: '/',
  script: '⧉',
  prompt: '·',
  include: '▣',
};

const NODE = 'flex items-center gap-2.5 overflow-hidden rounded-[9px] border px-3.5';
const LABEL = 'font-mono text-[10px] font-semibold uppercase tracking-[0.04em] text-text-secondary';

const placed = (box: Box) => ({ left: box.x, top: box.y, width: box.width, height: box.height });

const lapsOf = (n: number) => `${n} ${n === 1 ? 'lap' : 'laps'}`;

/**
 * A step: a link to its detail. A folded include or loop group is a button instead, showing its
 * step count and the laps anywhere inside it; a click opens it in place.
 */
function Step({
  node,
  box,
  onOpen,
}: {
  node: StepNode;
  /** Where the box is drawn; none for a step a folded block hides. */
  box?: Box;
  onOpen?: (block: string) => void;
}): ReactElement {
  const running = node.liveCount > 0;
  const others = node.factories.filter((f) => !f.current);
  const laps = `${lapsOf(node.liveCount)} on it${
    others.length > 0 ? `; ${others.map((f) => `${f.factory} ${lapsOf(f.laps)}`).join(', ')}` : ''
  }`;
  const fold = node.folded;
  const shared = {
    'data-node-role': node.role,
    'data-workflow': node.workflow,
    'data-step': node.id,
    'data-live-count': node.liveCount,
    title: `${node.id} · ${node.kind} · ${laps}`,
    className: `${NODE} absolute text-left transition-colors hover:brightness-110 ${
      fold === undefined ? '' : 'cursor-pointer border-dashed'
    } ${
      running
        ? 'border-[color:color-mix(in_oklch,var(--running),transparent_40%)] bg-[color:color-mix(in_oklch,var(--running),transparent_90%)]'
        : 'border-border-bright bg-surface-elevated'
    }`,
    style: box === undefined ? undefined : placed(box),
  };
  const body = (
    <>
      <span
        aria-hidden="true"
        className={`w-3 shrink-0 font-mono text-[15px] font-bold leading-none ${
          running ? 'text-[color:var(--running)]' : 'text-text-secondary'
        }`}
      >
        {KIND_GLYPH[node.kind] ?? '·'}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        {/* The whole name, never cut: the layout sized this box for these lines. */}
        <span
          data-step-name
          className="flex flex-col whitespace-nowrap font-mono text-[13px] font-semibold leading-[17px] text-text-primary"
        >
          {stepLabelLines(node.label).map((line, index) => (
            <span key={index === 0 ? 'first' : 'second'}>{line}</span>
          ))}
        </span>
        {fold?.notes.map((note) => (
          <span
            key={note}
            data-fold-note
            className="whitespace-nowrap font-mono text-[11px] leading-[15px] tabular-nums text-text-secondary"
          >
            {note}
          </span>
        ))}
        {others.length > 0 ? (
          <span
            data-factory-counts
            className="flex flex-col whitespace-nowrap font-mono text-[10px] leading-[15px] tabular-nums"
          >
            {node.factories.map((f) => (
              <span
                key={f.factory}
                data-factory-count={f.factory}
                data-laps={f.laps}
                className={f.current ? 'text-text-primary' : 'text-text-secondary'}
              >
                {`${f.factory} ${f.laps}`}
              </span>
            ))}
          </span>
        ) : null}
      </span>
      {running ? <LiveDot size={8} /> : null}
      {others.length > 0 ? null : (
        <span
          className={`font-mono text-[12px] tabular-nums ${
            running ? 'text-text-primary' : 'text-text-secondary'
          }`}
        >
          {node.liveCount}
        </span>
      )}
    </>
  );
  return fold === undefined ? (
    <Link to={node.href} aria-label={`${node.label}, ${laps}`} {...shared}>
      {body}
    </Link>
  ) : (
    <button
      type="button"
      data-folded={fold.steps}
      aria-expanded={false}
      aria-label={`${node.label}: ${fold.notes.join(', ')}, ${laps}. Show its steps.`}
      onClick={() => onOpen?.(node.id)}
      {...shared}
    >
      {body}
    </button>
  );
}

function Frame({ node }: { node: FrameNode }): ReactElement {
  const workflow = node.role === 'input' || node.role === 'manager';
  return (
    <div
      data-node-role={node.role}
      className={`${NODE} py-2.5 text-[13px] ${
        workflow
          ? 'border-border-bright bg-surface-elevated font-mono font-semibold text-text-primary'
          : 'border-border bg-surface text-text-secondary'
      }`}
    >
      {node.label}
    </div>
  );
}

/**
 * A workflow's steps laid out with dagre. Each top-level include or loop group opens with its own
 * steps boxed beside the spine, branching as they run; each block inside one opens folded, one box
 * with its step count. A click opens a folded block in place, boxed with what it nests, and its
 * Fold button folds it again. Folded, its steps are in the page, hidden: every link and count is
 * there.
 */
function StepGraphView({
  graph: full,
  label,
  narrow,
}: {
  graph: StepGraph;
  label: string;
  narrow: boolean;
}): ReactElement {
  const [toggled, setToggled] = useState<ReadonlyMap<string, boolean>>(new Map());
  const opened = useMemo(() => openedBlocks(topBlocks(full), toggled), [full, toggled]);
  const { graph, hidden } = useMemo(() => foldSteps(full, opened), [full, opened]);
  const toggle = (block: string, open: boolean) =>
    setToggled((was) => new Map(was).set(block, open));
  const laid = useMemo(() => layoutSteps(graph, narrow), [graph, narrow]);
  const first = laid.nodes.get(graph.steps[0]?.id ?? '');
  return (
    <GraphViewport label={label} anchorX={first ? first.x + first.width / 2 : 0}>
      <div className="relative mx-auto" style={{ width: laid.width, height: laid.height }}>
        <svg
          aria-hidden="true"
          className="absolute inset-0 overflow-visible"
          width={laid.width}
          height={laid.height}
        >
          {laid.edges.map((e) => (
            <path
              key={`${e.from}→${e.to}`}
              d={e.d}
              fill="none"
              stroke="var(--border-bright)"
              strokeWidth={1.5}
            />
          ))}
        </svg>
        {/* A route fork's labels: the values of the route each side runs on. */}
        {laid.edges.map((e) =>
          e.label === undefined || e.labelAt === undefined ? null : (
            <span
              key={`label:${e.from}→${e.to}`}
              data-edge-label={e.to}
              className="absolute -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded-md border border-border bg-surface px-1.5 font-mono text-[11px] leading-[16px] text-text-secondary"
              style={{ left: e.labelAt.x, top: e.labelAt.y }}
            >
              {e.label}
            </span>
          ),
        )}
        {[...laid.clusters].map(([parent, box]) => (
          <div
            key={parent}
            className="absolute rounded-lg border border-dashed border-border-bright"
            style={placed(box)}
          >
            <button
              type="button"
              data-fold={parent}
              onClick={() => toggle(parent, false)}
              aria-label={`Fold ${parent} back into one box`}
              className="absolute -top-2.5 right-3 cursor-pointer rounded-md border border-border-bright bg-surface px-2 py-0 font-mono text-[11px] leading-[18px] text-text-secondary hover:text-text-primary"
            >
              Fold
            </button>
          </div>
        ))}
        {graph.steps.map((node) => {
          const box = laid.nodes.get(node.id);
          return box === undefined ? null : (
            <Step key={node.id} node={node} box={box} onOpen={(block) => toggle(block, true)} />
          );
        })}
        {hidden.length === 0 ? null : (
          <div hidden>
            {hidden.map((node) => (
              <Step key={node.id} node={node} />
            ))}
          </div>
        )}
      </div>
    </GraphViewport>
  );
}

/**
 * An input or the manager: a workflow of the pack, folded to one card with its name, how many
 * steps it has and how many of the factory's runs are in it now, so the loop opens above the fold.
 * A click shows its steps in place, and folds them again; folded, they are in the page but hidden. It stays folded while a run is in it:
 * the card's count and live dot show the run, and the page keeps its shape.
 */
function WorkflowCard({
  node,
  graph,
  narrow,
}: {
  node: FrameNode;
  graph: StepGraph;
  narrow: boolean;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const nested = new Set([...graph.clusters.values()].flat());
  // A run is on one top-level step at a time, and counts on it from anywhere beneath it.
  const running = graph.steps.filter((s) => !nested.has(s.id)).reduce((n, s) => n + s.liveCount, 0);
  const steps = `${graph.steps.length} ${graph.steps.length === 1 ? 'step' : 'steps'}`;
  return (
    <div
      data-node-role={node.role}
      data-workflow-card={node.label}
      data-folded={open ? 'false' : 'true'}
      data-live-count={running}
      className="flex max-w-full flex-col gap-2 rounded-[9px] border border-border-bright bg-surface-elevated p-2.5"
    >
      <button
        type="button"
        data-card-toggle
        aria-expanded={open}
        aria-label={`${node.label}: ${steps}, ${running} running. ${open ? 'Fold' : 'Show'} its steps.`}
        onClick={() => setOpen((was) => !was)}
        className="flex cursor-pointer items-center gap-2.5 rounded-md bg-surface-elevated px-1 text-left hover:brightness-125"
      >
        <span aria-hidden="true" className="w-3 font-mono text-[12px] text-text-secondary">
          {open ? '▾' : '▸'}
        </span>
        <span className="font-mono text-[13px] font-semibold text-text-primary">{node.label}</span>
        <span className="font-mono text-[12px] text-text-secondary">· {steps}</span>
        {running > 0 ? <LiveDot size={8} /> : null}
        <span
          className={`ml-auto font-mono text-[12px] tabular-nums ${
            running > 0 ? 'text-text-primary' : 'text-text-secondary'
          }`}
        >
          {running}
        </span>
      </button>
      {/* Folded, its steps stay in the page, hidden: every link is there to open. */}
      <div hidden={!open}>
        <StepGraphView graph={graph} label={node.label} narrow={narrow} />
      </div>
    </div>
  );
}

function Band({ label, children }: { label: string; children: ReactNode }): ReactElement {
  return (
    <section className="flex flex-col gap-2">
      <h2 className={LABEL}>{label}</h2>
      {children}
    </section>
  );
}

/**
 * The factory at the pinned version: what feeds it and the manager above the loop, the loop laid
 * out with dagre, and what it produces below. The loop, each input workflow and the manager open
 * with each top-level include's own steps beside the spine and every deeper include folded to one
 * box, opened in place on a click. Every step shows
 * how many of the factory's laps are on it now, and each other shown factory's laps there under
 * that factory's name, and opens its detail under the workflow that declares it.
 */
export function HomeMap({
  rows,
  factories,
}: {
  rows: readonly HomeMapRow[];
  /** The factories the server shows; another factory's laps are not on the map. */
  factories: readonly string[];
}): ReactElement {
  const map = useMemo(() => homeMap(rows, factories), [rows, factories]);
  const narrow = useSyncExternalStore(subscribeScreen, narrowScreen, () => false);
  const frames = (nodes: FrameNode[]) => (
    <div className="flex flex-wrap items-start gap-2">
      {nodes.map((node) => {
        const graph = map.workflows.get(node.label);
        return graph && graph.steps.length > 0 ? (
          <WorkflowCard key={node.id} node={node} graph={graph} narrow={narrow} />
        ) : (
          <Frame key={node.id} node={node} />
        );
      })}
    </div>
  );
  return (
    <div className="flex flex-col gap-5">
      <Band label="Inputs">{frames(map.inputs)}</Band>
      <Band label="Manager">{frames(map.manager)}</Band>
      <Band label="Loop">
        <StepGraphView graph={map.loop} label="loop" narrow={narrow} />
      </Band>
      <Band label="Outputs">{frames(map.outputs)}</Band>
    </div>
  );
}
