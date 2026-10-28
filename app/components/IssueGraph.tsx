import { type ReactElement, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ISSUE_STATES,
  type IssueGraphRow,
  type IssueState,
  issueGraph,
  issueView,
  layoutPhases,
  longestOpenChain,
  NODE,
  type PhaseBar,
  type PlacedColumn,
  type PlacedIssue,
  phaseBars,
  STATE_TOKEN,
} from '../lib/issue-graph';
import { LivePanel } from '../live/LivePanel';
import { EmptyState } from './EmptyState';

const LABEL = 'font-mono text-[10px] font-semibold uppercase tracking-[0.04em] text-text-secondary';
const MONO = 'font-mono text-[12px] tabular-nums';
/** The graph's column headers sit above the nodes, in their own strip. */
const HEADER = 52;
/** What the graph is laid out for before the browser has measured it (the screen's width). */
const FIRST_WIDTH = 1104;

function look(label: string, state: IssueState) {
  const color = `var(${STATE_TOKEN[state]})`;
  return { label, color, text: color };
}

/**
 * Colors go inline, as in the console's graph: its `.console-root *` border color outranks
 * Tailwind's border utilities.
 */
const STATE_LOOK: Record<IssueState, { label: string; color: string; text: string }> = {
  waiting: look('Waiting', 'waiting'),
  claimed: look('Claimed', 'claimed'),
  'pr-open': look('PR open', 'pr-open'),
  'needs-owner': look('Needs owner', 'needs-owner'),
  merged: look('Merged', 'merged'),
  closed: { ...look('Closed', 'closed'), text: 'var(--text-secondary)' },
};

const tint = (color: string, transparent: number) =>
  `color-mix(in oklch, ${color}, transparent ${transparent}%)`;

const plural = (n: number, noun: string) => `${n} ${n === 1 ? noun : `${noun}s`}`;

/** One factory's product-document phases and its live issue dependency graph. */
export function IssueGraph({ factory }: { factory: string | undefined }): ReactElement {
  return (
    <LivePanel<IssueGraphRow> query="issue-graph" factory={factory}>
      {(rows, state) =>
        state === 'error' ? (
          <p className="text-sm text-text-secondary">Live data is unavailable.</p>
        ) : rows === undefined ? (
          <p className="text-sm text-text-secondary">Loading issues.</p>
        ) : rows.length === 0 ? (
          <EmptyState title="No issues recorded for this factory yet." />
        ) : (
          <IssueScreen rows={rows} />
        )
      }
    </LivePanel>
  );
}

/** The width an element has to draw in, kept current as the window resizes. */
function useWidth(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(FIRST_WIDTH);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () => setWidth(Math.floor(element.clientWidth));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

export function IssueScreen({
  rows,
  showMerged: initiallyShowMerged = false,
}: {
  rows: readonly IssueGraphRow[];
  showMerged?: boolean;
}): ReactElement {
  const [showMerged, setShowMerged] = useState(initiallyShowMerged);
  const [ref, width] = useWidth();
  const [hovered, setHovered] = useState<number | null>(null);
  const { graph, bars, chain } = useMemo(() => {
    const graph = issueGraph(rows);
    return { graph, bars: phaseBars(graph.issues), chain: new Set(longestOpenChain(graph)) };
  }, [rows]);
  const view = useMemo(() => issueView(graph, { showMerged }), [graph, showMerged]);
  const layout = useMemo(() => layoutPhases(view, width), [view, width]);
  const onChain = (number: number) => chain.has(number);
  const closedNumbers = new Set(
    graph.issues.filter((i) => i.state === 'merged' || i.state === 'closed').map((i) => i.number),
  );
  const weight = (dep: { from: number; on: number }) =>
    (hovered !== null && (dep.from === hovered || dep.on === hovered) ? 4 : 0) +
    (onChain(dep.from) && onChain(dep.on) ? 2 : 0) +
    (closedNumbers.has(dep.on) ? 0 : 1);
  const open = view.columns.reduce((n, c) => n + c.open, 0);
  const merged = view.columns.reduce((n, c) => n + c.merged, 0);
  const closed = view.columns.reduce((n, c) => n + c.closed, 0);
  const { done } = view;
  const doneCounts = (counts: { merged: number; closed: number }) =>
    [`${counts.merged} merged`, counts.closed > 0 ? `${counts.closed} closed` : null]
      .filter((c) => c !== null)
      .join(', ');
  return (
    <>
      <h1 className={`${LABEL} mb-3`}>Phases</h1>
      {bars.length === 0 ? (
        <p className="text-sm text-text-secondary">No issue names a phase yet.</p>
      ) : (
        <ol className="grid gap-3 md:grid-cols-3">
          {bars.map((bar) => (
            <Phase key={bar.phase} bar={bar} />
          ))}
        </ol>
      )}
      <div className="mt-8 mb-3 flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <h2 className={LABEL}>Issue graph</h2>
          <p data-graph-summary className={`${MONO} text-text-secondary`}>
            {showMerged
              ? `Every issue: ${open} open, ${merged} merged, ${closed} closed`
              : `${plural(open, 'open issue')} and what they depend on`}
          </p>
          {!showMerged && done.phases > 0 ? (
            <p
              data-done-phases={done.phases}
              data-done-merged={done.merged}
              data-done-closed={done.closed}
              className={`${MONO} text-text-secondary`}
            >
              {`${plural(done.phases, 'phase')} done: ${doneCounts(done)}`}
            </p>
          ) : null}
          {!showMerged && done.unphased ? (
            <p className={`${MONO} text-text-secondary`}>
              {`No phase: ${doneCounts(done.unphased)}`}
            </p>
          ) : null}
          {view.hidden > 0 ? (
            <p data-hidden-open={view.hidden} className={`${MONO} text-text-primary`}>
              {plural(view.hidden, 'more open issue')} not drawn (furthest from merge)
            </p>
          ) : null}
        </div>
        <button
          type="button"
          data-show-merged
          aria-pressed={showMerged}
          onClick={() => setShowMerged((v) => !v)}
          className={`${MONO} cursor-pointer rounded-md border px-3 py-1.5 transition-colors ${
            showMerged
              ? 'border-border-bright bg-surface-elevated text-text-primary'
              : 'border-border bg-surface text-text-secondary hover:text-text-primary'
          }`}
        >
          {showMerged ? 'Hide merged' : 'Show merged'}
        </button>
      </div>
      <Legend context={!showMerged} />
      <div ref={ref} className="mt-3 w-full">
        {layout.columns.length === 0 ? (
          <p className="text-sm text-text-secondary">No open issues: every phase is done.</p>
        ) : null}
        <div
          className={layout.overflows ? 'overflow-x-auto' : undefined}
          data-graph-overflows={layout.overflows ? 'true' : undefined}
        >
          <div className="relative" style={{ width: layout.width, height: HEADER + layout.height }}>
            {layout.columns.map((column) => (
              <Column key={column.phase ?? ''} column={column} height={HEADER + layout.height} />
            ))}
            <svg
              aria-hidden="true"
              className="absolute left-0"
              style={{ top: HEADER }}
              width={layout.width}
              height={layout.height}
            >
              {[...layout.dependencies]
                // Drawn last is drawn on top: the chain and the hovered issue's edges.
                .sort((a, b) => weight(a) - weight(b))
                .map((dep) => {
                  const chained = onChain(dep.from) && onChain(dep.on);
                  const touched = hovered !== null && (dep.from === hovered || dep.on === hovered);
                  // An edge from work already done is satisfied: faint and dashed.
                  const done = closedNumbers.has(dep.on);
                  return (
                    <path
                      key={`${dep.from}-${dep.on}`}
                      data-dependency={`${dep.from}-${dep.on}`}
                      data-satisfied={done ? 'true' : undefined}
                      d={dep.d}
                      fill="none"
                      className={
                        chained || touched
                          ? 'stroke-text-primary'
                          : done
                            ? 'stroke-border-bright'
                            : 'stroke-text-secondary'
                      }
                      strokeWidth={chained || touched ? 2.5 : done ? 1 : 1.5}
                      strokeDasharray={done && !touched ? '4 4' : undefined}
                      opacity={hovered !== null && !touched ? 0.25 : undefined}
                    />
                  );
                })}
            </svg>
            {layout.issues.map((issue) => (
              <Node
                key={issue.number}
                issue={issue}
                highlighted={onChain(issue.number)}
                onHover={setHovered}
              />
            ))}
          </div>
        </div>
      </div>
    </>
  );
}

/** A phase's column: its name and counts on top, a quiet band behind its issues. */
function Column({ column, height }: { column: PlacedColumn; height: number }): ReactElement {
  const name = column.phase ?? 'No phase';
  const counts = [
    column.open > 0 ? `${column.open} open` : null,
    `${column.merged} merged`,
    column.closed > 0 ? `${column.closed} closed` : null,
  ]
    .filter((c) => c !== null)
    .join(' · ');
  return (
    <section
      data-phase-column={column.phase ?? ''}
      data-open={column.open}
      data-merged={column.merged}
      data-closed={column.closed}
      aria-label={`${name}: ${counts}`}
      className="absolute top-0 rounded-[10px] border border-border bg-surface"
      style={{ left: column.x, width: column.width, height }}
    >
      <div className="flex h-[52px] flex-col justify-center gap-0.5 border-b border-border px-3">
        <span className="truncate text-[13px] text-text-primary" title={name}>
          {name}
        </span>
        <span className={`${MONO} truncate text-[11px] text-text-secondary`}>{counts}</span>
      </div>
    </section>
  );
}

function Node({
  issue,
  highlighted,
  onHover,
}: {
  issue: PlacedIssue;
  highlighted: boolean;
  onHover: (number: number | null) => void;
}): ReactElement {
  const look = STATE_LOOK[issue.state];
  return (
    <a
      href={issue.url}
      title={`#${issue.number} ${issue.title}${
        issue.context ? ` (${issue.phase ?? 'no phase'}, done; an open issue depends on it)` : ''
      }`}
      data-issue={issue.number}
      data-issue-state={issue.state}
      data-longest-chain={highlighted ? 'true' : undefined}
      data-context={issue.context ? 'true' : undefined}
      onMouseEnter={() => onHover(issue.number)}
      onMouseLeave={() => onHover(null)}
      onFocus={() => onHover(issue.number)}
      onBlur={() => onHover(null)}
      className={`absolute flex flex-col justify-center gap-1 rounded-[9px] border px-2.5 hover:brightness-110 ${
        highlighted ? 'ring-2 ring-selected' : ''
      } ${issue.context ? 'border-dashed' : ''}`}
      style={{
        left: issue.x,
        top: HEADER + issue.y,
        width: issue.width,
        height: NODE.height,
        backgroundColor: issue.context ? 'var(--surface-inset)' : tint(look.color, 88),
        borderColor: tint(look.color, issue.context ? 40 : 45),
      }}
    >
      <span className="flex min-w-0 items-center gap-2">
        <span
          data-state-dot
          aria-hidden="true"
          className="inline-block h-2 w-2 shrink-0 rounded-full"
          style={{ backgroundColor: look.color }}
        />
        <span className={`${MONO} font-semibold text-text-primary`}>#{issue.number}</span>
        {issue.context ? null : (
          <span
            className="ml-auto truncate font-mono text-[10px] font-semibold uppercase tracking-[0.05em]"
            style={{ color: look.text }}
          >
            {look.label}
          </span>
        )}
      </span>
      {issue.context ? (
        <span
          className="truncate font-mono text-[10px] font-semibold uppercase tracking-[0.05em]"
          style={{ color: look.text }}
        >
          {look.label}
        </span>
      ) : (
        <span className="truncate text-[12px] text-text-secondary">{issue.title}</span>
      )}
    </a>
  );
}

function Phase({ bar }: { bar: PhaseBar }): ReactElement {
  const percent = bar.total === 0 ? 0 : Math.round((bar.merged / bar.total) * 100);
  return (
    <li
      data-phase={bar.phase}
      data-merged={bar.merged}
      data-total={bar.total}
      className="flex flex-col gap-2 rounded-[10px] border border-border bg-surface px-[18px] py-[13px]"
    >
      <div className="flex items-baseline justify-between gap-3">
        <span className="min-w-0 truncate text-[13px] text-text-primary">{bar.phase}</span>
        <span className={`${MONO} shrink-0 text-text-secondary`}>
          {bar.merged}/{bar.total} merged
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={`${bar.phase}: ${bar.merged} of ${bar.total} merged`}
        aria-valuemin={0}
        aria-valuemax={bar.total}
        aria-valuenow={bar.merged}
        className="h-1.5 overflow-hidden rounded-full bg-surface-inset"
      >
        <div className="h-full rounded-full bg-success" style={{ width: `${percent}%` }} />
      </div>
    </li>
  );
}

function Legend({ context }: { context: boolean }): ReactElement {
  return (
    <ul className="flex flex-wrap items-center gap-x-5 gap-y-2">
      {ISSUE_STATES.map((state) => (
        <li key={state} className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className="inline-block h-2 w-2 rounded-full"
            style={{ backgroundColor: STATE_LOOK[state].color }}
          />
          <span className="text-[12px] text-text-secondary">{STATE_LOOK[state].label}</span>
        </li>
      ))}
      <li className="flex items-center gap-2">
        <span aria-hidden="true" className="inline-block h-0.5 w-4 bg-text-primary" />
        <span className="text-[12px] text-text-secondary">Longest open chain</span>
      </li>
      {context ? (
        <li className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className="inline-block h-3 w-4 rounded-[3px] border border-dashed border-border-bright"
          />
          <span className="text-[12px] text-text-secondary">Done, an open issue depends on it</span>
        </li>
      ) : null}
    </ul>
  );
}
