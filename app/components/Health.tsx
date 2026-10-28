import { type ReactElement, type ReactNode, useMemo } from 'react';
import { Link } from 'react-router';
import { formatElapsed, shortRunId } from '../lib/format';
import {
  CAUSE_LABEL,
  CAUSES,
  countByCause,
  type FailedLap,
  failedLaps,
  type HealthRunRow,
  type HealthStepRow,
  type HealthWorkableRow,
  OVERDUE_FACTOR,
  overdueSteps,
  waitingRuns,
  workable,
} from '../lib/health';
import { since, stepLabel } from '../lib/laps';
import { waited } from '../lib/owner-queue';
import { LivePanel } from '../live/LivePanel';
import { LABEL, MONO, NONE, PanelBody, useNow, utcMinute } from './Lanes';
import { LiveDot } from './LiveDot';

const LINK = `${MONO} shrink-0 text-text-secondary underline decoration-border-bright underline-offset-2 hover:decoration-text-primary`;
const CARD = 'relative overflow-hidden rounded-[10px] border border-border bg-surface';
const STATUS_LABEL = 'font-mono text-[11px] font-semibold uppercase tracking-[0.05em]';

function Heading({ count, children }: { count?: number; children: ReactNode }): ReactElement {
  return (
    <h2 className={`${LABEL} mb-3`}>
      {children}
      {count === undefined ? null : (
        <span data-count={count} className="ml-2 text-text-primary tabular-nums">
          {count}
        </span>
      )}
    </h2>
  );
}

function LapLink({ factory, runId }: { factory: string; runId: string }): ReactElement {
  return (
    <Link to={`/f/${encodeURIComponent(factory)}/laps/${runId}`} data-lap-link className={LINK}>
      {shortRunId(runId)}
    </Link>
  );
}

/** A bar's fill as a share of its track: at least a sliver, so a nonzero value is never invisible. */
const share = (value: number, max: number) =>
  max <= 0 ? '0%' : `${Math.max(2, Math.min(100, (value / max) * 100))}%`;

/** A horizontal bar on an inset track, filled to `width` in `color`. */
function Bar({
  width,
  color,
  glow = false,
}: {
  width: string;
  color: string;
  glow?: boolean;
}): ReactElement {
  return (
    <div aria-hidden="true" className="h-2.5 overflow-hidden rounded-full bg-surface-inset">
      <div
        className="h-full rounded-full"
        style={{
          width,
          backgroundColor: color,
          boxShadow: glow ? `0 0 10px color-mix(in oklch, ${color}, transparent 50%)` : undefined,
        }}
      />
    </div>
  );
}

/** A status dot and its label in one of the console's status colors. */
function Status({ color, children }: { color: string; children: ReactNode }): ReactElement {
  return (
    <span className="flex items-center gap-[9px]">
      <span
        aria-hidden="true"
        className="h-2 w-2 shrink-0 rounded-full"
        style={{ backgroundColor: color }}
      />
      <span className={STATUS_LABEL} style={{ color }}>
        {children}
      </span>
    </span>
  );
}

/**
 * One factory's health (PRD 4.8): runs waiting to start or resume, steps running far past their
 * usual time, failed laps by cause, and workable issues against running laps.
 */
export function Health({ factory }: { factory: string | undefined }): ReactElement {
  return (
    <div className="grid gap-8">
      <h1 className={LABEL}>Health</h1>
      <LivePanel<HealthRunRow> query="health-runs" factory={factory} className="grid gap-8">
        {(rows, state) => (
          <PanelBody rows={rows} state={state} factory={factory} what="waiting and failed runs">
            {(loaded, name) => (
              <>
                <WaitingList rows={loaded} factory={name} />
                <Failures rows={loaded} factory={name} />
              </>
            )}
          </PanelBody>
        )}
      </LivePanel>
      <LivePanel<HealthStepRow> query="health-steps" factory={factory}>
        {(rows, state) => (
          <PanelBody rows={rows} state={state} factory={factory} what="running steps">
            {(loaded, name) => <OverdueList rows={loaded} factory={name} />}
          </PanelBody>
        )}
      </LivePanel>
      <LivePanel<HealthWorkableRow> query="health-workable" factory={factory}>
        {(rows, state) => (
          <PanelBody rows={rows} state={state} factory={factory} what="workable issues">
            {(loaded) => <Workable rows={loaded} />}
          </PanelBody>
        )}
      </LivePanel>
    </div>
  );
}

const WAITING_LABEL = { pending: 'Pending', paused: 'Paused' } as const;

/**
 * Runs waiting to start or resume, each drawn as a bar of how long it has waited against the
 * longest wait, so the run that has waited longest reads first by length rather than by date.
 */
export function WaitingList({
  rows,
  factory,
  now: fixed,
}: {
  rows: readonly HealthRunRow[];
  factory: string;
  /** A fixed clock, for tests; the screen uses the browser's. */
  now?: number;
}): ReactElement {
  const ticking = useNow();
  const now = fixed ?? ticking;
  const runs = useMemo(() => waitingRuns(rows), [rows]);
  const waits = runs.map((run) => since(run.started_at, now));
  const longest = Math.max(0, ...waits.map((wait) => wait ?? 0));
  return (
    <section>
      <Heading count={runs.length}>Pending and paused runs</Heading>
      {runs.length === 0 ? (
        <p className="text-sm text-text-secondary">No run is pending or paused.</p>
      ) : (
        <ol className={`${CARD} grid gap-4 px-[18px] py-4`}>
          {runs.map((run, index) => {
            const wait = waits[index] ?? null;
            return (
              <li
                key={run.run_id}
                data-waiting-run={run.run_id}
                data-status={run.status}
                className="grid gap-x-[18px] gap-y-2 sm:grid-cols-[220px_minmax(0,1fr)_88px_84px] sm:items-center"
              >
                <span className="flex min-w-0 items-center gap-x-3">
                  <Status color="var(--warning)">{WAITING_LABEL[run.status]}</Status>
                  <span className={`${MONO} min-w-0 truncate font-bold text-text-primary`}>
                    {run.workflow_name}
                  </span>
                </span>
                <span className="grid min-w-0 gap-1.5">
                  {wait === null ? null : (
                    <Bar width={share(wait, longest)} color="var(--warning)" />
                  )}
                  <span className={`${MONO} text-[11px] text-text-secondary`}>
                    {run.started_at === null
                      ? 'start not recorded'
                      : `since ${utcMinute(run.started_at)}`}
                  </span>
                </span>
                <span className={`${MONO} font-semibold text-text-primary sm:text-right`}>
                  {wait === null ? (
                    NONE
                  ) : (
                    <span data-waited className="text-text-primary">
                      {waited(wait)}
                    </span>
                  )}
                </span>
                <span className="sm:text-right">
                  <LapLink factory={factory} runId={run.run_id} />
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

/**
 * Failed laps by cause, drawn as one bar per cause against the commonest, every cause even at
 * zero; then the failed laps themselves, records read row by row, so they stay a table.
 */
export function Failures({
  rows,
  factory,
}: {
  rows: readonly HealthRunRow[];
  factory: string;
}): ReactElement {
  const laps = useMemo(() => failedLaps(rows), [rows]);
  const counts = countByCause(laps);
  const most = Math.max(0, ...CAUSES.map((cause) => counts[cause]));
  return (
    <section>
      <Heading count={laps.length}>Failed laps by cause</Heading>
      <dl className={`${CARD} mb-3 grid gap-3 px-[18px] py-4`}>
        {CAUSES.map((cause) => (
          <div
            key={cause}
            data-cause={cause}
            data-count={counts[cause]}
            className="grid grid-cols-[120px_minmax(0,1fr)_32px] items-center gap-x-[18px] sm:grid-cols-[150px_minmax(0,1fr)_40px]"
          >
            <dt className={LABEL}>{CAUSE_LABEL[cause]}</dt>
            <dd className="min-w-0">
              <Bar
                width={counts[cause] === 0 ? '0%' : share(counts[cause], most)}
                color="var(--error)"
              />
            </dd>
            <dd
              className="text-right font-mono text-[16px] font-semibold tabular-nums"
              style={{ color: counts[cause] > 0 ? 'var(--error)' : 'var(--text-secondary)' }}
            >
              {counts[cause]}
            </dd>
          </div>
        ))}
      </dl>
      {laps.length === 0 ? (
        <p className="text-sm text-text-secondary">No lap has failed.</p>
      ) : (
        <ol className={`${CARD} overflow-hidden`}>
          {laps.map((lap) => (
            <FailedRow key={lap.run_id} lap={lap} factory={factory} />
          ))}
        </ol>
      )}
    </section>
  );
}

function FailedRow({ lap, factory }: { lap: FailedLap; factory: string }): ReactElement {
  const ended = lap.failed_at ?? lap.completed_at;
  return (
    <li
      data-failed-lap={lap.run_id}
      data-cause={lap.cause}
      className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-[18px] gap-y-1 border-b border-border/40 px-[18px] py-[13px] last:border-b-0 sm:grid-cols-[150px_120px_minmax(0,1fr)_170px_84px]"
    >
      <Status color="var(--error)">{CAUSE_LABEL[lap.cause]}</Status>
      <span className={`${MONO} min-w-0 truncate text-text-primary`}>
        {lap.failed_step === null ? 'no failed step' : stepLabel(lap.failed_step)}
      </span>
      <span
        data-error
        title={lap.error ?? undefined}
        className={`${MONO} col-span-2 min-w-0 truncate text-text-secondary sm:col-span-1`}
      >
        {lap.error ?? 'no error recorded'}
      </span>
      <span className={`${MONO} min-w-0 truncate text-text-secondary`}>
        {ended === null ? NONE : utcMinute(ended)}
      </span>
      <LapLink factory={factory} runId={lap.run_id} />
    </li>
  );
}

/** The ticks of the overdue scale: p90, the overdue threshold, then each power of ten to `top`. */
function overdueTicks(top: number): { at: number; label: string }[] {
  const ticks = [
    { at: 1, label: 'p90' },
    { at: OVERDUE_FACTOR, label: `${OVERDUE_FACTOR}×` },
  ];
  for (let at = 10; at <= top; at *= 10) ticks.push({ at, label: `${at}×` });
  return ticks;
}

/**
 * How far past its p90 a step has run, on a log scale starting at p90: a step at 3× and one at
 * 500× both read at a glance, where a linear bar would draw the first as nothing.
 */
function OverdueScale({ ratio, top }: { ratio: number; top: number }): ReactElement {
  const at = (value: number) => `${(Math.log10(Math.max(1, value)) / Math.log10(top)) * 100}%`;
  return (
    <div aria-hidden="true" className="relative mx-2 pb-6">
      <div className="relative h-2.5 rounded-full bg-surface-inset">
        <div
          className="absolute inset-y-0 left-0 animate-pulse rounded-full bg-[color:var(--running)] shadow-[0_0_12px_color-mix(in_oklch,var(--running),transparent_50%)]"
          style={{ width: at(ratio) }}
        />
      </div>
      {overdueTicks(top).map((tick) => (
        <span
          key={tick.at}
          className="absolute top-0 flex -translate-x-1/2 flex-col items-center"
          style={{ left: at(tick.at) }}
        >
          <span className="h-[16px] w-px bg-border-bright" />
          <span className="font-mono text-[10px] text-text-secondary">{tick.label}</span>
        </span>
      ))}
    </div>
  );
}

export function OverdueList({
  rows,
  factory,
  now: fixed,
}: {
  rows: readonly HealthStepRow[];
  factory: string;
  /** A fixed clock, for tests; the screen uses the browser's. */
  now?: number;
}): ReactElement {
  const ticking = useNow();
  const now = fixed ?? ticking;
  const steps = useMemo(() => overdueSteps(rows, now), [rows, now]);
  const ratios = steps.map((step) => step.running_ms / step.p90_ms);
  // One scale for every step so their bars compare: the next power of ten, at least 10×.
  const top = 10 ** Math.max(1, Math.ceil(Math.log10(Math.max(1, ...ratios))));
  return (
    <section>
      <Heading count={steps.length}>Steps running past {OVERDUE_FACTOR}× their p90</Heading>
      {steps.length === 0 ? (
        <p className="text-sm text-text-secondary">No step has run past twice its usual time.</p>
      ) : (
        <ol className="grid gap-3">
          {steps.map((step, index) => (
            <li
              key={`${step.run_id} ${step.step_id}`}
              data-overdue-step={step.step_id}
              data-run={step.run_id}
              className={`${CARD} py-[13px] pr-[18px] pl-[22px]`}
            >
              <span
                aria-hidden="true"
                className="absolute inset-y-0 left-0 w-[3px] bg-[color:var(--running)]"
              />
              <div className="flex flex-wrap items-center gap-x-[18px] gap-y-2">
                <Status color="var(--running)">Running</Status>
                <span className={`${MONO} min-w-0 flex-1 truncate font-bold text-text-primary`}>
                  {stepLabel(step.step_id)}
                </span>
                <span className="font-mono text-[15px] font-semibold tabular-nums text-text-primary">
                  {Math.floor(ratios[index] ?? 0)}× p90
                </span>
                <LapLink factory={factory} runId={step.run_id} />
              </div>
              <div className="mt-3">
                <OverdueScale ratio={ratios[index] ?? 1} top={top} />
              </div>
              <p className={`${MONO} mt-2 flex flex-wrap gap-x-6 gap-y-1 text-text-secondary`}>
                <span className="text-text-primary">
                  <span className="text-text-secondary">running for </span>
                  <span data-running-for>{formatElapsed(step.running_ms / 1000)}</span>
                </span>
                <span className="text-text-primary">
                  <span className="text-text-secondary">p90 </span>
                  <span data-p90>{formatElapsed(step.p90_ms / 1000)}</span>
                </span>
                <span>
                  started <span className="text-text-primary">{utcMinute(step.started_at)}</span>
                </span>
                <span>
                  over <span className="text-text-primary">{step.completions}</span> completions
                </span>
              </p>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/**
 * Workable issues against running laps: each issue a tile and each running lap a live dot, side
 * by side, so whether the queue outruns the laps reads from the two sizes.
 */
export function Workable({ rows }: { rows: readonly HealthWorkableRow[] }): ReactElement {
  const { issues, running } = useMemo(() => workable(rows), [rows]);
  return (
    <section>
      <h2 className={`${LABEL} mb-3`}>Workable issues against running laps</h2>
      <div className="grid gap-3 md:grid-cols-[minmax(0,3fr)_minmax(0,1fr)]">
        <div
          data-tally="workable"
          data-count={issues.length}
          className={`${CARD} flex flex-col gap-3 px-[18px] py-[13px]`}
        >
          <div className="flex items-baseline justify-between gap-3">
            <span className={LABEL}>Workable issues</span>
            <span className="font-mono text-[22px] font-semibold tabular-nums text-text-primary">
              {issues.length}
            </span>
          </div>
          {issues.length === 0 ? (
            <p className="text-sm text-text-secondary">No issue is workable.</p>
          ) : (
            <ol className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {issues.map((issue) => (
                <li
                  key={issue.issue_number}
                  data-workable-issue={issue.issue_number}
                  className="flex min-w-0 items-baseline gap-2.5 rounded-md border border-border bg-surface-elevated px-3 py-2"
                >
                  <a
                    href={issue.url}
                    className={`${MONO} shrink-0 font-bold text-text-primary underline decoration-border-bright underline-offset-2 hover:decoration-text-primary`}
                  >
                    #{issue.issue_number}
                  </a>
                  <span
                    title={issue.title}
                    className="min-w-0 truncate text-[12.5px] text-text-secondary"
                  >
                    {issue.title}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </div>
        <div
          data-tally="running"
          data-count={running}
          className={`${CARD} flex flex-col gap-3 px-[18px] py-[13px]`}
        >
          <div className="flex items-baseline justify-between gap-3">
            <span className={LABEL}>Running laps</span>
            <span className="font-mono text-[22px] font-semibold tabular-nums text-text-primary">
              {running}
            </span>
          </div>
          {running === 0 ? (
            <p className="text-sm text-text-secondary">No lap is running.</p>
          ) : (
            <div aria-hidden="true" className="flex flex-wrap gap-2.5">
              {Array.from({ length: running }, (_, lap) => (
                <span
                  // biome-ignore lint/suspicious/noArrayIndexKey: one dot per running lap, with no identity of its own
                  key={lap}
                  className="flex h-9 w-9 items-center justify-center rounded-md border border-border bg-surface-elevated"
                >
                  <LiveDot size={10} />
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
