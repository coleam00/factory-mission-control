import { type ReactElement, type ReactNode, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { formatCost, formatElapsed, shortRunId } from '../lib/format';
import {
  costOf,
  durationOf,
  type LaneRow,
  lanes,
  OUTCOME_LABEL,
  OUTCOME_TOKEN,
  type RecentLapRow,
  recentLaps,
  since,
  stepLabel,
} from '../lib/laps';
import { LivePanel, type PanelState } from '../live/LivePanel';

export const LABEL =
  'font-mono text-[10px] font-semibold uppercase tracking-[0.04em] text-text-secondary';
export const MONO = 'font-mono text-[12px] tabular-nums';
export const NONE = 'not recorded';

/** The browser's clock, once a second: elapsed times are computed here, never in a query. */
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** The error and loading sentences the laps screen's panels and a lap's share. */
export function PanelBody<Row>({
  rows,
  state,
  factory,
  what,
  children,
}: {
  rows: readonly Row[] | undefined;
  state: PanelState;
  factory: string | undefined;
  what: string;
  children: (rows: readonly Row[], factory: string) => ReactNode;
}): ReactElement {
  if (state === 'error') {
    return <p className="text-sm text-text-secondary">Live data is unavailable.</p>;
  }
  if (rows === undefined || factory === undefined) {
    return <p className="text-sm text-text-secondary">Loading {what}.</p>;
  }
  return <>{children(rows, factory)}</>;
}

/** `2026-10-24 10:00 UTC`: the same moment for every viewer. */
export const utcMinute = (at: Date) => `${at.toISOString().slice(0, 16).replace('T', ' ')} UTC`;

const costText = (value: number | string | null) => formatCost(costOf(value) ?? 0);

/** One lane per running lap: its issue, route and depth, the step it is on and since when. */
export function Lanes({ factory }: { factory: string | undefined }): ReactElement {
  return (
    <LivePanel<LaneRow> query="lanes" factory={factory}>
      {(rows, state) => (
        <>
          <h1 className={`${LABEL} mb-3`}>Lanes</h1>
          <PanelBody rows={rows} state={state} factory={factory} what="lanes">
            {(loaded, name) =>
              loaded.length === 0 ? (
                <p className="text-sm text-text-secondary">No lap is running.</p>
              ) : (
                <LaneList rows={loaded} factory={name} />
              )
            }
          </PanelBody>
        </>
      )}
    </LivePanel>
  );
}

export function LaneList({
  rows,
  factory,
  now: fixed,
}: {
  rows: readonly LaneRow[];
  factory: string;
  /** A fixed clock, for tests; the screen uses the browser's. */
  now?: number;
}): ReactElement {
  const ticking = useNow();
  const now = fixed ?? ticking;
  const sorted = useMemo(() => lanes(rows), [rows]);
  return (
    <ol className="grid gap-3">
      {sorted.map((lane) => {
        const onStep = since(lane.step_started_at, now);
        return (
          <li
            key={lane.run_id}
            data-lane={lane.run_id}
            data-issue={lane.issue_number ?? undefined}
            data-route={lane.route ?? undefined}
            data-depth={lane.depth ?? undefined}
            data-step={lane.step_id ?? undefined}
            data-step-started={lane.step_started_at?.toISOString()}
            data-cost={costOf(lane.cost_usd) ?? 0}
            className="relative overflow-hidden rounded-[10px] border border-border bg-surface py-[13px] pr-[18px] pl-[22px]"
          >
            <span
              aria-hidden="true"
              className="absolute inset-y-0 left-0 w-[3px] animate-pulse bg-[color:var(--running)] shadow-[0_0_12px_color-mix(in_oklch,var(--running),transparent_60%)]"
            />
            <div className="flex flex-wrap items-center gap-x-[18px] gap-y-2">
              <span className="flex items-center gap-[9px]">
                <span
                  aria-hidden="true"
                  className="h-2 w-2 shrink-0 rounded-full bg-[color:var(--running)]"
                />
                <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.05em] text-[color:var(--running)]">
                  Running
                </span>
              </span>
              <span className="flex min-w-0 flex-1 items-baseline gap-2.5">
                {lane.issue_number === null ? (
                  <span className={`${MONO} text-text-secondary`}>No issue claimed yet</span>
                ) : lane.issue_url === null ? (
                  <span className={`${MONO} font-bold text-text-primary`}>
                    #{lane.issue_number}
                  </span>
                ) : (
                  <a
                    href={lane.issue_url}
                    className={`${MONO} shrink-0 font-bold text-text-primary underline decoration-border-bright underline-offset-2 hover:decoration-text-primary`}
                  >
                    #{lane.issue_number}
                  </a>
                )}
                {lane.issue_title === null ? null : (
                  <span className="min-w-0 truncate text-[12.5px] text-text-secondary">
                    {lane.issue_title}
                  </span>
                )}
              </span>
              <Link
                to={`/f/${encodeURIComponent(factory)}/laps/${lane.run_id}`}
                data-lap-link
                className={`${MONO} text-text-secondary underline decoration-border-bright underline-offset-2 hover:decoration-text-primary`}
              >
                {shortRunId(lane.run_id)}
              </Link>
            </div>
            <dl className="mt-3 grid grid-cols-2 gap-x-[18px] gap-y-2 sm:grid-cols-5">
              <Field label="Route">{lane.route ?? NONE}</Field>
              <Field label="Depth">{lane.depth ?? NONE}</Field>
              <Field label="Step">
                <span className="text-[color:var(--running)]">
                  {lane.step_id === null ? 'not started' : stepLabel(lane.step_id)}
                </span>
              </Field>
              <Field label="On step for">
                <span data-elapsed>{onStep === null ? NONE : formatElapsed(onStep)}</span>
              </Field>
              <Field label="Cost so far">{costText(lane.cost_usd)}</Field>
            </dl>
          </li>
        );
      })}
    </ol>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }): ReactElement {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <dt className={LABEL}>{label}</dt>
      <dd className={`${MONO} min-w-0 truncate text-text-primary`}>{children}</dd>
    </div>
  );
}

/** Every finished lap, newest first, with its outcome, duration and cost, each opening its lap. */
export function RecentLaps({ factory }: { factory: string | undefined }): ReactElement {
  return (
    <LivePanel<RecentLapRow> query="recent-laps" factory={factory}>
      {(rows, state) => (
        <>
          <h2 className={`${LABEL} mb-3`}>Recent laps</h2>
          <PanelBody rows={rows} state={state} factory={factory} what="recent laps">
            {(loaded, name) =>
              loaded.length === 0 ? (
                <p className="text-sm text-text-secondary">No lap has finished yet.</p>
              ) : (
                <RecentList rows={loaded} factory={name} />
              )
            }
          </PanelBody>
        </>
      )}
    </LivePanel>
  );
}

export function RecentList({
  rows,
  factory,
}: {
  rows: readonly RecentLapRow[];
  factory: string;
}): ReactElement {
  const sorted = useMemo(() => recentLaps(rows), [rows]);
  return (
    <ol className="overflow-hidden rounded-[10px] border border-border bg-surface">
      {sorted.map((lap) => {
        const duration = durationOf(lap);
        const color = lap.outcome === null ? undefined : `var(${OUTCOME_TOKEN[lap.outcome]})`;
        // The console's grey is too dim for text on a surface; its dot keeps it.
        const text = lap.outcome === 'nothing' ? undefined : color;
        const label =
          lap.outcome === null ? `No outcome, ${lap.status}` : OUTCOME_LABEL[lap.outcome];
        return (
          <li
            key={lap.run_id}
            data-recent-lap={lap.run_id}
            data-outcome={lap.outcome ?? undefined}
            data-cost={costOf(lap.cost_usd) ?? 0}
            className="border-b border-border/40 last:border-b-0"
          >
            <Link
              to={`/f/${encodeURIComponent(factory)}/laps/${lap.run_id}`}
              aria-label={`Lap ${shortRunId(lap.run_id)}: ${label}`}
              className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-[18px] gap-y-1 px-[18px] py-[13px] transition-colors hover:bg-surface-hover sm:grid-cols-[150px_64px_minmax(0,1fr)_84px_84px_64px]"
            >
              <span className="flex items-center gap-[9px]">
                <span
                  data-outcome-dot
                  aria-hidden="true"
                  className="h-2 w-2 shrink-0 rounded-full bg-text-tertiary"
                  style={color === undefined ? undefined : { backgroundColor: color }}
                />
                <span
                  className="font-mono text-[11px] font-semibold uppercase tracking-[0.05em] text-text-secondary"
                  style={text === undefined ? undefined : { color: text }}
                >
                  {label}
                </span>
              </span>
              <span className={`${MONO} min-w-0 truncate text-text-primary`}>
                {lap.issue_number === null ? 'No issue' : `#${lap.issue_number}`}
              </span>
              <span className={`${MONO} min-w-0 truncate text-text-secondary`}>
                {lap.completed_at === null
                  ? 'end not recorded'
                  : `ended ${utcMinute(lap.completed_at)}`}
              </span>
              <span className={`${MONO} text-text-secondary sm:text-right`}>
                {shortRunId(lap.run_id)}
              </span>
              <span className={`${MONO} text-right text-text-secondary`} data-duration>
                {duration === null ? NONE : formatElapsed(duration)}
              </span>
              <span className={`${MONO} text-right text-text-primary`}>
                {costText(lap.cost_usd)}
              </span>
            </Link>
          </li>
        );
      })}
    </ol>
  );
}
