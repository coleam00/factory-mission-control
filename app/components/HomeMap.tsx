import { type ReactElement, type ReactNode, useMemo } from 'react';
import { Link } from 'react-router';
import {
  type Box,
  type FrameNode,
  type HomeMapRow,
  homeMap,
  layoutLoop,
  type StepNode,
} from '../lib/home-map';
import { LiveDot } from './LiveDot';

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

function Step({ node, box }: { node: StepNode; box: Box }): ReactElement {
  const running = node.liveCount > 0;
  const others = node.factories.filter((f) => !f.current);
  const laps = `${lapsOf(node.liveCount)} on it${
    others.length > 0 ? `; ${others.map((f) => `${f.factory} ${lapsOf(f.laps)}`).join(', ')}` : ''
  }`;
  return (
    <Link
      to={node.href}
      data-node-role={node.role}
      data-step={node.id}
      data-live-count={node.liveCount}
      aria-label={`${node.label}, ${laps}`}
      title={`${node.label} · ${node.kind} · ${laps}`}
      className={`${NODE} absolute transition-colors hover:brightness-110 ${
        running
          ? 'border-[color:color-mix(in_oklch,var(--running),transparent_40%)] bg-[color:color-mix(in_oklch,var(--running),transparent_90%)]'
          : 'border-border-bright bg-surface-elevated'
      }`}
      style={placed(box)}
    >
      <span
        aria-hidden="true"
        className={`w-3 shrink-0 font-mono text-[15px] font-bold leading-none ${
          running ? 'text-[color:var(--running)]' : 'text-text-secondary'
        }`}
      >
        {KIND_GLYPH[node.kind] ?? '·'}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-mono text-[13px] font-semibold text-text-primary">
          {node.label}
        </span>
        {others.length > 0 ? (
          <span
            data-factory-counts
            className="flex gap-2 truncate font-mono text-[10px] tabular-nums"
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
    </Link>
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

function Band({ label, children }: { label: string; children: ReactNode }): ReactElement {
  return (
    <section className="flex flex-col gap-2">
      <h2 className={LABEL}>{label}</h2>
      {children}
    </section>
  );
}

const frames = (nodes: FrameNode[]) => (
  <div className="flex flex-wrap gap-2">
    {nodes.map((node) => (
      <Frame key={node.id} node={node} />
    ))}
  </div>
);

/**
 * The factory at the pinned version: what feeds it and the manager above the loop, the loop laid
 * out with dagre (each expanded step's stages boxed beside it), and what it produces below. Every
 * step shows how many of the factory's laps are on it now, and each other factory's laps there
 * under that factory's name, and opens its detail.
 */
export function HomeMap({ rows }: { rows: readonly HomeMapRow[] }): ReactElement {
  const map = useMemo(() => homeMap(rows), [rows]);
  const laid = useMemo(() => layoutLoop(map), [map]);
  return (
    <div className="flex flex-col gap-5">
      <Band label="Inputs">{frames(map.inputs)}</Band>
      <Band label="Manager">{frames(map.manager)}</Band>
      <Band label="Loop">
        <div className="overflow-x-auto rounded-lg border border-border bg-surface-inset">
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
            {[...laid.clusters].map(([parent, box]) => (
              <div
                key={parent}
                aria-hidden="true"
                className="absolute rounded-lg border border-dashed border-border-bright"
                style={placed(box)}
              />
            ))}
            {map.loop.map((node) => {
              const box = laid.nodes.get(node.id);
              return box === undefined ? null : <Step key={node.id} node={node} box={box} />;
            })}
          </div>
        </div>
      </Band>
      <Band label="Outputs">{frames(map.outputs)}</Band>
    </div>
  );
}
