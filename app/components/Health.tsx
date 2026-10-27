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
import { Field, LABEL, MONO, NONE, PanelBody, useNow, utcMinute } from './Lanes';

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

/** A count in a card; `alarm` shows it in the failed red. Data attributes go on the card. */
function Tally({
  label,
  count,
  alarm = false,
  ...data
}: {
  label: string;
  count: number;
  alarm?: boolean;
} & Record<`data-${string}`, string>): ReactElement {
  return (
    <div {...data} data-count={count} className={`${CARD} flex flex-col gap-1 px-[18px] py-[13px]`}>
      <dt className={LABEL}>{label}</dt>
      <dd
        className="font-mono text-[22px] font-semibold tabular-nums"
        style={{ color: alarm ? 'var(--error)' : 'var(--text-primary)' }}
      >
        {count}
      </dd>
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
  return (
    <section>
      <Heading count={runs.length}>Pending and paused runs</Heading>
      {runs.length === 0 ? (
        <p className="text-sm text-text-secondary">No run is pending or paused.</p>
      ) : (
        <ol className="grid gap-3">
          {runs.map((run) => {
            const wait = since(run.started_at, now);
            return (
              <li
                key={run.run_id}
                data-waiting-run={run.run_id}
                data-status={run.status}
                className={`${CARD} flex flex-wrap items-center gap-x-[18px] gap-y-2 py-[13px] pr-[18px] pl-[22px]`}
              >
                <span aria-hidden="true" className="absolute inset-y-0 left-0 w-[3px] bg-warning" />
                <Status color="var(--warning)">{WAITING_LABEL[run.status]}</Status>
                <span className={`${MONO} min-w-0 flex-1 truncate font-bold text-text-primary`}>
                  {run.workflow_name}
                </span>
                <span className={`${MONO} text-text-secondary`}>
                  {run.started_at === null
                    ? 'start not recorded'
                    : `since ${utcMinute(run.started_at)}`}
                  {wait === null ? null : (
                    <>
                      {' '}
                      <span data-waited className="text-text-primary">
                        {waited(wait)}
                      </span>
                    </>
                  )}
                </span>
                <LapLink factory={factory} runId={run.run_id} />
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

export function Failures({
  rows,
  factory,
}: {
  rows: readonly HealthRunRow[];
  factory: string;
}): ReactElement {
  const laps = useMemo(() => failedLaps(rows), [rows]);
  const counts = countByCause(laps);
  return (
    <section>
      <Heading count={laps.length}>Failed laps by cause</Heading>
      <dl className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {CAUSES.map((cause) => (
          <Tally
            key={cause}
            label={CAUSE_LABEL[cause]}
            count={counts[cause]}
            alarm={counts[cause] > 0}
            data-cause={cause}
          />
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
  return (
    <section>
      <Heading count={steps.length}>Steps running past {OVERDUE_FACTOR}× their p90</Heading>
      {steps.length === 0 ? (
        <p className="text-sm text-text-secondary">No step has run past twice its usual time.</p>
      ) : (
        <ol className="grid gap-3">
          {steps.map((step) => (
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
                <LapLink factory={factory} runId={step.run_id} />
              </div>
              <dl className="mt-3 grid grid-cols-2 gap-x-[18px] gap-y-2 sm:grid-cols-4">
                <Field label="Running for">
                  <span data-running-for>{formatElapsed(step.running_ms / 1000)}</span>
                </Field>
                <Field label="p90">
                  <span data-p90>{formatElapsed(step.p90_ms / 1000)}</span>
                </Field>
                <Field label="Started">{utcMinute(step.started_at)}</Field>
                <Field label="Over completions">{step.completions}</Field>
              </dl>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

export function Workable({ rows }: { rows: readonly HealthWorkableRow[] }): ReactElement {
  const { issues, running } = useMemo(() => workable(rows), [rows]);
  return (
    <section>
      <h2 className={`${LABEL} mb-3`}>Workable issues against running laps</h2>
      <dl className="mb-3 grid grid-cols-2 gap-3 sm:max-w-md">
        <Tally label="Workable issues" count={issues.length} data-tally="workable" />
        <Tally label="Running laps" count={running} data-tally="running" />
      </dl>
      {issues.length === 0 ? (
        <p className="text-sm text-text-secondary">No issue is workable.</p>
      ) : (
        <ol className={`${CARD} overflow-hidden`}>
          {issues.map((issue) => (
            <li
              key={issue.issue_number}
              data-workable-issue={issue.issue_number}
              className="flex items-baseline gap-2.5 border-b border-border/40 px-[18px] py-[13px] last:border-b-0"
            >
              <a
                href={issue.url}
                className={`${MONO} shrink-0 font-bold text-text-primary underline decoration-border-bright underline-offset-2 hover:decoration-text-primary`}
              >
                #{issue.issue_number}
              </a>
              <span className="min-w-0 truncate text-[12.5px] text-text-secondary">
                {issue.title}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
