import { type ReactElement, useMemo } from 'react';
import {
  ISSUE_STATES,
  type IssueGraphRow,
  type IssueState,
  issueGraph,
  layoutGraph,
  longestOpenChain,
  NODE,
  type PhaseBar,
  phaseBars,
  STATE_TOKEN,
} from '../lib/issue-graph';
import { LivePanel } from '../live/LivePanel';
import { EmptyState } from './EmptyState';
import { GraphViewport } from './GraphViewport';

const LABEL = 'font-mono text-[10px] font-semibold uppercase tracking-[0.04em] text-text-secondary';
const MONO = 'font-mono text-[12px] tabular-nums';

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

export function IssueScreen({ rows }: { rows: readonly IssueGraphRow[] }): ReactElement {
  const { graph, bars, chain } = useMemo(() => {
    const graph = issueGraph(rows);
    return { graph, bars: phaseBars(graph.issues), chain: new Set(longestOpenChain(graph)) };
  }, [rows]);
  const layout = useMemo(() => layoutGraph(graph), [graph]);
  const root = layout.issues.find(
    (issue) => !graph.dependencies.some((dependency) => dependency.from === issue.number),
  );
  const onChain = (number: number) => chain.has(number);
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
      <h2 className={`${LABEL} mt-8 mb-3`}>Issue graph</h2>
      <Legend />
      <GraphViewport
        label="issue graph"
        anchorX={(root?.x ?? 0) + NODE.width / 2}
        className="mt-3 rounded-[10px]"
      >
        <div className="relative mx-auto" style={{ width: layout.width, height: layout.height }}>
          <svg
            aria-hidden="true"
            className="absolute inset-0"
            width={layout.width}
            height={layout.height}
          >
            {layout.dependencies.map((dep) => {
              const highlighted = onChain(dep.from) && onChain(dep.on);
              return (
                <path
                  key={`${dep.from}-${dep.on}`}
                  data-dependency={`${dep.from}-${dep.on}`}
                  d={dep.d}
                  fill="none"
                  className={highlighted ? 'stroke-text-primary' : 'stroke-border-bright'}
                  strokeWidth={highlighted ? 2 : 1.5}
                />
              );
            })}
          </svg>
          {layout.issues.map((issue) => {
            const look = STATE_LOOK[issue.state];
            const highlighted = onChain(issue.number);
            return (
              <a
                key={issue.number}
                href={issue.url}
                title={`#${issue.number} ${issue.title}`}
                data-issue={issue.number}
                data-issue-state={issue.state}
                data-longest-chain={highlighted ? 'true' : undefined}
                className={`absolute flex flex-col justify-center gap-1 rounded-[9px] border px-3 hover:brightness-110 ${
                  highlighted ? 'ring-2 ring-text-primary' : ''
                }`}
                style={{
                  left: issue.x,
                  top: issue.y,
                  width: NODE.width,
                  height: NODE.height,
                  backgroundColor: tint(look.color, 92),
                  borderColor: tint(look.color, 50),
                }}
              >
                <span className="flex items-center gap-2">
                  <span
                    data-state-dot
                    aria-hidden="true"
                    className="inline-block h-2 w-2 shrink-0 rounded-full"
                    style={{ backgroundColor: look.color }}
                  />
                  <span className={`${MONO} text-text-primary`}>#{issue.number}</span>
                  <span
                    className="ml-auto font-mono text-[10px] font-semibold uppercase tracking-[0.05em]"
                    style={{ color: look.text }}
                  >
                    {look.label}
                  </span>
                </span>
                <span className="truncate text-[12px] text-text-secondary">{issue.title}</span>
              </a>
            );
          })}
        </div>
      </GraphViewport>
    </>
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

function Legend(): ReactElement {
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
    </ul>
  );
}
