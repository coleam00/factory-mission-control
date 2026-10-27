import { type ReactElement, type ReactNode, useMemo } from 'react';
import { formatCost, formatElapsed, shortRunId } from '../lib/format';
import { costOf, durationOf, OUTCOME_LABEL, OUTCOME_TOKEN, since, stepLabel } from '../lib/laps';
import {
  actionText,
  attemptSeconds,
  attemptsInOrder,
  type CheckLineRow,
  consoleUrl,
  GATE_TOKEN,
  issueUrl,
  lapCost,
  lapOutcome,
  linesInOrder,
  type OneLapRow,
  prNumber,
  pullUrl,
  REVIEW_TOKEN,
  STEP_STATUS_TOKEN,
  type StepAttemptRow,
  VERDICT_TOKEN,
} from '../lib/one-lap';
import { LivePanel } from '../live/LivePanel';
import { Field, LABEL, MONO, NONE, PanelBody, useNow, utcMinute } from './Lanes';

const CARD = 'rounded-[10px] border border-border bg-surface';
const LINK = 'underline decoration-border-bright underline-offset-2 hover:decoration-text-primary';
const TAG = 'font-mono text-[11px] font-semibold uppercase tracking-[0.05em]';

/** `2026-10-24 10:00:30 UTC`: a step's start, to the second, the same for every viewer. */
const utcSecond = (at: Date) => `${at.toISOString().slice(0, 19).replace('T', ' ')} UTC`;

const tokenColor = (token: `--${string}` | undefined) =>
  token === undefined ? undefined : { color: `var(${token})` };

/** A value the lap never recorded, in the console's quietest text. */
function None({ children = 'none' }: { children?: ReactNode }): ReactElement {
  return <span className="text-text-tertiary">{children}</span>;
}

/** The lap: its outcome, route and depth, its links, its review and its merge gate. */
export function LapHeader({
  factory,
  runId,
}: {
  factory: string | undefined;
  runId: string;
}): ReactElement {
  return (
    <LivePanel<OneLapRow> query="one-lap" factory={factory} args={[runId]}>
      {(rows, state) => (
        <PanelBody rows={rows} state={state} factory={factory} what="the lap">
          {(loaded) =>
            loaded[0] === undefined ? (
              <p className="text-sm text-text-secondary">
                No lap {shortRunId(runId)} in this factory.
              </p>
            ) : (
              <LapHeaderBody lap={loaded[0]} />
            )
          }
        </PanelBody>
      )}
    </LivePanel>
  );
}

export function LapHeaderBody({
  lap,
  now: fixed,
}: {
  lap: OneLapRow;
  /** A fixed clock, for tests; the screen uses the browser's. */
  now?: number;
}): ReactElement {
  const ticking = useNow();
  const now = fixed ?? ticking;
  const outcome = lapOutcome(lap);
  const running = lap.status === 'running';
  const color = running
    ? 'var(--running)'
    : outcome === null
      ? undefined
      : `var(${OUTCOME_TOKEN[outcome]})`;
  // The console's grey is too dim for text on a surface; its dot keeps it.
  const text = outcome === 'nothing' ? undefined : color;
  const label = running ? 'Running' : outcome === null ? lap.status : OUTCOME_LABEL[outcome];
  const seconds = running ? since(lap.started_at, now) : durationOf(lap);
  const pr = prNumber(lap.pr);
  return (
    <div
      data-lap={lap.run_id}
      data-status={lap.status}
      data-outcome={outcome ?? undefined}
      data-route={lap.route ?? undefined}
      data-depth={lap.depth ?? undefined}
      data-issue={lap.issue_number ?? undefined}
      data-pr={pr ?? undefined}
      className="grid gap-6"
    >
      <div className={`${CARD} grid gap-4 py-[15px] pr-[18px] pl-[22px]`}>
        <div className="flex flex-wrap items-center gap-x-[18px] gap-y-2">
          <h1 className="flex items-center gap-[9px]">
            <span
              aria-hidden="true"
              className="h-2 w-2 shrink-0 rounded-full bg-text-tertiary"
              style={color === undefined ? undefined : { backgroundColor: color }}
            />
            <span
              className={`${TAG} text-text-secondary`}
              style={text === undefined ? undefined : { color: text }}
            >
              {label}
            </span>
            <span className={`${MONO} text-text-primary`}>Lap {shortRunId(lap.run_id)}</span>
          </h1>
          <span className="flex min-w-0 flex-1 items-baseline gap-2.5">
            {lap.issue_number === null ? (
              <span className={`${MONO} text-text-secondary`}>No issue claimed</span>
            ) : (
              <a
                data-link="issue"
                href={issueUrl(lap.repository, lap.issue_number)}
                className={`${MONO} shrink-0 font-bold text-text-primary ${LINK}`}
              >
                #{lap.issue_number}
              </a>
            )}
            {lap.issue_title === null ? null : (
              <span className="min-w-0 truncate text-[12.5px] text-text-secondary">
                {lap.issue_title}
              </span>
            )}
          </span>
        </div>
        <dl className="grid grid-cols-2 gap-x-[18px] gap-y-2 sm:grid-cols-5">
          <Field label="Route">{lap.route ?? NONE}</Field>
          <Field label="Depth">{lap.depth ?? NONE}</Field>
          <Field label="Started">
            {lap.started_at === null ? NONE : utcMinute(lap.started_at)}
          </Field>
          <Field label={running ? 'Running for' : 'Duration'}>
            <span data-duration>{seconds === null ? NONE : formatElapsed(seconds)}</span>
          </Field>
          <Field label="Pull request">
            {pr === null ? (
              (lap.pr ?? NONE)
            ) : (
              <a data-link="pr" href={pullUrl(lap.repository, pr)} className={LINK}>
                #{pr}
              </a>
            )}
          </Field>
        </dl>
        <a
          data-link="console"
          href={consoleUrl(lap.console, lap.run_id)}
          className={`${MONO} w-fit text-text-secondary ${LINK}`}
        >
          The full run in the Archon console
        </a>
      </div>
      <div className="grid gap-6 sm:grid-cols-2">
        <Review lap={lap} />
        <Gate lap={lap} />
      </div>
    </div>
  );
}

function Review({ lap }: { lap: OneLapRow }): ReactElement {
  const outcome = lap.review_outcome;
  return (
    <section
      data-review
      data-review-outcome={outcome ?? undefined}
      data-review-delivers={lap.review_delivers ?? undefined}
      className="grid content-start gap-3"
    >
      <h2 className={LABEL}>Review</h2>
      {lap.review_status === null ? (
        <p className="text-sm text-text-secondary">The review has not run.</p>
      ) : (
        <div className={`${CARD} grid gap-3 px-[18px] py-[13px]`}>
          <dl className="grid grid-cols-2 gap-x-[18px] gap-y-2">
            <Field label="Outcome">
              {outcome === null ? (
                <None>{lap.review_status}</None>
              ) : (
                <span style={tokenColor(REVIEW_TOKEN[outcome])}>{outcome}</span>
              )}
            </Field>
            <Field label="Delivers">{lap.review_delivers ?? <None />}</Field>
          </dl>
          {(lap.dispositions ?? []).length === 0 ? (
            <p className="text-sm text-text-secondary">No disposition.</p>
          ) : (
            <ol className="grid gap-1.5">
              {(lap.dispositions ?? []).map((d, i) => {
                const action = actionText(d.action);
                return (
                  <li
                    // biome-ignore lint/suspicious/noArrayIndexKey: a disposition's place in the review is its only identity
                    key={i}
                    data-disposition
                    data-line={d.line ?? undefined}
                    data-action={action ?? undefined}
                    className={`${MONO} flex flex-wrap gap-x-3 text-text-primary`}
                  >
                    <span className="text-text-secondary">{d.line ?? 'no line id'}</span>
                    <span className="[overflow-wrap:anywhere]">{action ?? <None />}</span>
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      )}
    </section>
  );
}

function Gate({ lap }: { lap: OneLapRow }): ReactElement {
  const outcome = lap.gate_outcome;
  return (
    <section
      data-gate
      data-gate-outcome={outcome ?? undefined}
      className="grid content-start gap-3"
    >
      <h2 className={LABEL}>Merge gate</h2>
      {lap.gate_status === null ? (
        <p className="text-sm text-text-secondary">The merge gate has not run.</p>
      ) : (
        <div className={`${CARD} grid gap-3 px-[18px] py-[13px]`}>
          <dl className="grid grid-cols-2 gap-x-[18px] gap-y-2">
            <Field label="Outcome">
              {outcome === null ? (
                <None>{lap.gate_status}</None>
              ) : (
                <span style={tokenColor(GATE_TOKEN[outcome])}>{outcome}</span>
              )}
            </Field>
          </dl>
          <div className="flex flex-col gap-1">
            <span className={LABEL}>Reason</span>
            <p data-gate-reason className="text-[13px] text-text-primary [overflow-wrap:anywhere]">
              {lap.gate_reason ?? <None />}
            </p>
          </div>
        </div>
      )}
    </section>
  );
}

/** Every step the lap ran, each attempt of a repeated step on its own row, and the lap's cost. */
export function LapSteps({
  factory,
  runId,
}: {
  factory: string | undefined;
  runId: string;
}): ReactElement {
  return (
    <LivePanel<StepAttemptRow> query="one-lap-steps" factory={factory} args={[runId]}>
      {(rows, state) => (
        <>
          <h2 className={`${LABEL} mb-3`}>Steps</h2>
          <PanelBody rows={rows} state={state} factory={factory} what="the steps">
            {(loaded) =>
              loaded.length === 0 ? (
                <p className="text-sm text-text-secondary">No step has started yet.</p>
              ) : (
                <StepList rows={loaded} />
              )
            }
          </PanelBody>
        </>
      )}
    </LivePanel>
  );
}

const thousands = (n: number | string) => Number(n).toLocaleString('en-US');

export function StepList({
  rows,
  now: fixed,
}: {
  rows: readonly StepAttemptRow[];
  /** A fixed clock, for tests; the screen uses the browser's. */
  now?: number;
}): ReactElement {
  const ticking = useNow();
  const now = fixed ?? ticking;
  const sorted = useMemo(() => attemptsInOrder(rows), [rows]);
  const total = lapCost(rows);
  return (
    <div className="grid gap-3">
      <p className={`${MONO} text-text-secondary`}>
        Lap cost{' '}
        <span data-lap-cost={total ?? 0} className="text-text-primary">
          {formatCost(total ?? 0)}
        </span>
      </p>
      <ol className={`${CARD} overflow-hidden`}>
        {sorted.map((attempt) => {
          const seconds = attemptSeconds(attempt, now);
          const cost = costOf(attempt.cost_usd);
          const token = STEP_STATUS_TOKEN[attempt.status];
          const cache =
            attempt.tokens_cache_read === null && attempt.tokens_cache_write === null
              ? undefined
              : `cache read ${thousands(attempt.tokens_cache_read ?? 0)}, cache write ${thousands(attempt.tokens_cache_write ?? 0)}`;
          return (
            <li
              key={`${attempt.step_id} ${attempt.started_at?.toISOString() ?? attempt.status}`}
              data-step-attempt
              data-step={attempt.step_id}
              data-status={attempt.status}
              data-started={attempt.started_at?.toISOString()}
              data-duration-ms={attempt.duration_ms ?? undefined}
              data-model={attempt.model ?? undefined}
              data-tokens-input={attempt.tokens_input ?? undefined}
              data-tokens-output={attempt.tokens_output ?? undefined}
              data-cost={cost ?? undefined}
              className={`${MONO} grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-[18px] gap-y-1 border-b border-border/40 px-[18px] py-[11px] last:border-b-0 sm:grid-cols-[minmax(0,1fr)_96px_170px_72px_64px_128px_64px]`}
            >
              <span className="flex min-w-0 items-center gap-[9px]">
                <span
                  aria-hidden="true"
                  className="h-2 w-2 shrink-0 rounded-full bg-text-tertiary"
                  style={token === undefined ? undefined : { backgroundColor: `var(${token})` }}
                />
                <span className="min-w-0 truncate text-text-primary">
                  {stepLabel(attempt.step_id)}
                </span>
                {attempt.outcome === null ? null : (
                  <span className="truncate text-text-secondary">{attempt.outcome}</span>
                )}
              </span>
              <span
                className={`${TAG} text-text-secondary`}
                style={
                  token === undefined || token === '--text-tertiary' ? undefined : tokenColor(token)
                }
              >
                {attempt.status}
              </span>
              <span className="min-w-0 truncate text-text-secondary">
                {attempt.started_at === null ? (
                  <None>no start</None>
                ) : (
                  utcSecond(attempt.started_at)
                )}
              </span>
              <span className="text-text-secondary sm:text-right">
                {seconds === null ? <None /> : formatElapsed(seconds)}
              </span>
              <span className="min-w-0 truncate text-text-secondary">
                {attempt.model ?? <None />}
              </span>
              <span className="text-text-secondary sm:text-right" title={cache}>
                {attempt.tokens_input === null && attempt.tokens_output === null ? (
                  <None />
                ) : (
                  `${thousands(attempt.tokens_input ?? 0)} / ${thousands(attempt.tokens_output ?? 0)}`
                )}
              </span>
              <span className="text-right text-text-primary">
                {cost === null ? <None /> : formatCost(cost)}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** The lap's app-check lines: kind, verdict, evidence count, and a holdout by its scenario id. */
export function LapChecks({
  factory,
  runId,
}: {
  factory: string | undefined;
  runId: string;
}): ReactElement {
  return (
    <LivePanel<CheckLineRow> query="one-lap-checks" factory={factory} args={[runId]}>
      {(rows, state) => (
        <>
          <h2 className={`${LABEL} mb-3`}>App check</h2>
          <PanelBody rows={rows} state={state} factory={factory} what="the app check">
            {(loaded) =>
              loaded.length === 0 ? (
                <p className="text-sm text-text-secondary">
                  No app check has reported on this lap.
                </p>
              ) : (
                <CheckList rows={loaded} />
              )
            }
          </PanelBody>
        </>
      )}
    </LivePanel>
  );
}

export function CheckList({ rows }: { rows: readonly CheckLineRow[] }): ReactElement {
  const sorted = useMemo(() => linesInOrder(rows), [rows]);
  return (
    <ol className={`${CARD} overflow-hidden`}>
      {sorted.map((line) => (
        <li
          key={line.position}
          data-check-line
          data-position={line.position}
          data-kind={line.kind}
          data-verdict={line.verdict}
          data-evidence={line.evidence_count}
          data-scenario={line.scenario_id ?? undefined}
          className={`${MONO} grid grid-cols-[32px_minmax(0,1fr)_auto] items-center gap-x-[18px] gap-y-1 border-b border-border/40 px-[18px] py-[11px] last:border-b-0 sm:grid-cols-[32px_96px_minmax(0,1fr)_72px_120px]`}
        >
          <span className="text-text-secondary">{line.position}</span>
          <span className="text-text-primary">{line.kind}</span>
          <span className="text-text-secondary">{line.scenario_id ?? ''}</span>
          <span
            className={`${TAG} text-text-secondary`}
            style={tokenColor(VERDICT_TOKEN[line.verdict])}
          >
            {line.verdict}
          </span>
          <span className="text-text-secondary sm:text-right">{line.evidence_count} evidence</span>
        </li>
      ))}
    </ol>
  );
}
