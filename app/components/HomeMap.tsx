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

/**
 * Each kind's color, from the console's node variant tokens: the same stripe and tinted badge
 * the Archon builder gives a node, so the map reads by kind at a glance. Tints are the token over
 * transparent, never a mix of two tokens, so every rendered color stays a token.
 */
const KIND_COLOR: Record<string, string> = {
  command: 'var(--node-command)',
  prompt: 'var(--node-prompt)',
  bash: 'var(--node-bash)',
  script: 'var(--node-script)',
  loop: 'var(--node-loop)',
  loop_group: 'var(--node-loop)',
  approval: 'var(--node-approval)',
  include: 'var(--node-wait)',
};
const kindColor = (kind: string) => KIND_COLOR[kind] ?? 'var(--node-opaque)';
const tint = (color: string, transparent: number) =>
  `color-mix(in oklch, ${color}, transparent ${transparent}%)`;

/** Each band's color: what feeds the factory, the manager, the loop, and what it ships. */
const BAND_COLOR: Record<string, string> = {
  Inputs: 'var(--accent-bright)',
  Manager: 'var(--node-approval)',
  Loop: 'var(--node-loop)',
  Outputs: 'var(--success)',
};

/** A 3px stripe flush left on a card, in its kind's or band's color. */
function Stripe({ color }: { color: string }): ReactElement {
  return (
    <span
      aria-hidden="true"
      className="absolute inset-y-0 left-0 w-[3px]"
      style={{ background: color }}
    />
  );
}

const bandColor = (label: string) => BAND_COLOR[label] ?? 'var(--accent-bright)';

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
  const color = kindColor(node.kind);
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
        : 'bg-surface-elevated'
    }`,
    style: {
      ...(box === undefined ? {} : placed(box)),
      ...(running ? {} : { borderColor: tint(color, 45), background: tint(color, 92) }),
    },
  };
  const body = (
    <>
      <Stripe color={running ? 'var(--running)' : color} />
      <span
        aria-hidden="true"
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md font-mono text-[14px] font-bold leading-none"
        style={{
          color: running ? 'var(--running)' : color,
          background: tint(running ? 'var(--running)' : color, 78),
        }}
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

function Frame({ node, color }: { node: FrameNode; color: string }): ReactElement {
  const workflow = node.role === 'input' || node.role === 'manager';
  return (
    <div
      data-node-role={node.role}
      className={`${NODE} relative py-2.5 pl-4 text-[13px] ${
        workflow
          ? 'bg-surface-elevated font-mono font-semibold text-text-primary'
          : 'bg-surface text-text-primary'
      }`}
      style={{ borderColor: tint(color, 50), background: tint(color, 93) }}
    >
      <Stripe color={color} />
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
              stroke={tint('var(--accent-bright)', 55)}
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
              className="absolute -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded-md border bg-surface px-1.5 font-mono text-[11px] leading-[16px] text-accent-bright"
              style={{
                left: e.labelAt.x,
                top: e.labelAt.y,
                borderColor: tint('var(--accent-bright)', 60),
              }}
            >
              {e.label}
            </span>
          ),
        )}
        {[...laid.clusters].map(([parent, box]) => (
          <div
            key={parent}
            className="absolute rounded-lg border border-dashed"
            style={{ ...placed(box), borderColor: tint('var(--accent-bright)', 65) }}
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
  color,
}: {
  node: FrameNode;
  graph: StepGraph;
  narrow: boolean;
  color: string;
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
      className="relative flex max-w-full flex-col gap-2 overflow-hidden rounded-[9px] border bg-surface-elevated p-2.5 pl-3.5"
      style={{ borderColor: tint(color, 45), background: tint(color, 92) }}
    >
      <Stripe color={running > 0 ? 'var(--running)' : color} />
      <button
        type="button"
        data-card-toggle
        aria-expanded={open}
        aria-label={`${node.label}: ${steps}, ${running} running. ${open ? 'Fold' : 'Show'} its steps.`}
        onClick={() => setOpen((was) => !was)}
        className="flex cursor-pointer items-center gap-2.5 rounded-md px-1 text-left hover:brightness-125"
      >
        <span aria-hidden="true" className="w-3 font-mono text-[12px]" style={{ color }}>
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
      <h2 className={`${LABEL} flex items-center gap-2`} style={{ color: bandColor(label) }}>
        <span
          aria-hidden="true"
          className="h-2 w-2 rounded-[2px]"
          style={{ background: bandColor(label) }}
        />
        {label}
      </h2>
      {children}
    </section>
  );
}

/**
 * The factory at the version its address names, else the current one: what feeds it and the manager above the loop, the loop laid
 * out with dagre, and what it produces below. The loop, each input workflow and the manager open
 * with each top-level include's own steps beside the spine and every deeper include folded to one
 * box, opened in place on a click. Every step shows
 * how many of the factory's laps are on it now, and each other shown factory's laps there under
 * that factory's name, and opens its detail under the workflow that declares it.
 */
export function HomeMap({
  rows,
  factories,
  at,
}: {
  rows: readonly HomeMapRow[];
  /** The factories the server shows; another factory's laps are not on the map. */
  factories: readonly string[];
  /** The pin of the version the map shows, or null for the current version. */
  at: string | null;
}): ReactElement {
  const map = useMemo(() => homeMap(rows, factories, at), [rows, factories, at]);
  const narrow = useSyncExternalStore(subscribeScreen, narrowScreen, () => false);
  const frames = (nodes: FrameNode[], color: string) => (
    <div className="flex flex-wrap items-start gap-2">
      {nodes.map((node) => {
        const graph = map.workflows.get(node.label);
        return graph && graph.steps.length > 0 ? (
          <WorkflowCard key={node.id} node={node} graph={graph} narrow={narrow} color={color} />
        ) : (
          <Frame key={node.id} node={node} color={color} />
        );
      })}
    </div>
  );
  return (
    <div className="flex flex-col gap-5">
      <Band label="Inputs">{frames(map.inputs, bandColor('Inputs'))}</Band>
      <Band label="Manager">{frames(map.manager, bandColor('Manager'))}</Band>
      <Band label="Loop">
        <StepGraphView graph={map.loop} label="loop" narrow={narrow} />
      </Band>
      <Band label="Outputs">{frames(map.outputs, bandColor('Outputs'))}</Band>
    </div>
  );
}
