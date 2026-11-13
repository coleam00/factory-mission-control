import { type ReactElement, type ReactNode, useEffect, useMemo, useState } from 'react';
import { formatCost, formatCount, formatElapsed, localSecond } from '../lib/format';
import { stepLabel } from '../lib/laps';
import {
  actionText,
  attemptSeconds,
  attemptsInOrder,
  type CheckLineRow,
  checkLineFor,
  linesInOrder,
  type OneLapRow,
  shownDispositions,
  type StepAttemptRow,
} from '../lib/one-lap';
import { type LapMapRow, lapGraph } from '../lib/lap-graph';
import {
  GATE_STATE,
  REVIEW_OUTCOME_STATE,
  type State,
  STEP_STATUS_STATE,
  stateColor,
  stateInk,
  stateOf,
  VERDICT_STATE,
} from '../lib/states';
import { runCost, stepCost } from '../lib/one-run';
import type { PanelState } from '../live/LivePanel';
import { LapGraphView, StepPanel } from './LapGraph';
import { Field, LABEL, MONO, useNow } from './panel';

const CARD = 'rounded-[10px] border border-border bg-surface';
const _LINK = 'underline decoration-border-bright underline-offset-2 hover:decoration-text-primary';
const TAG = 'font-mono text-[11px] font-semibold uppercase tracking-[0.05em]';

/** The text color of a value's state; none for a value no map knows. */
const inkOf = (state: State | undefined) =>
  state === undefined ? undefined : { color: stateInk(state) };

/** A value the lap never recorded. The console's tertiary grey is below 4.5:1 on a surface. */
export function None({ children = 'none' }: { children?: ReactNode }): ReactElement {
  return <span className="text-text-secondary">{children}</span>;
}

export function Review({
  lap,
  checks,
}: {
  lap: OneLapRow;
  checks: readonly CheckLineRow[] | undefined;
}): ReactElement {
  const outcome = lap.review_outcome;
  const dispositions = shownDispositions(lap);
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
                <span style={inkOf(stateOf(REVIEW_OUTCOME_STATE, outcome))}>{outcome}</span>
              )}
            </Field>
            <Field label="Delivers">{lap.review_delivers ?? <None />}</Field>
          </dl>
          {dispositions.length === 0 ? (
            <p className="text-sm text-text-secondary">No disposition.</p>
          ) : (
            <ol className="grid gap-1.5">
              {dispositions.map((d, i) => {
                const action = actionText(d.action);
                const answered = checks === undefined ? undefined : checkLineFor(d.line, checks);
                return (
                  <li
                    // biome-ignore lint/suspicious/noArrayIndexKey: a disposition's place in the review is its only identity
                    key={i}
                    data-disposition
                    data-line={d.line ?? undefined}
                    data-action={action ?? undefined}
                    data-check-position={answered?.position}
                    data-unmatched={answered === null ? '' : undefined}
                    className={`${MONO} flex flex-wrap gap-x-3 text-text-primary`}
                  >
                    <span className="text-text-secondary">{d.line ?? 'no line id'}</span>
                    <span className="[overflow-wrap:anywhere]">{action ?? <None />}</span>
                    {answered === null && <None>matches no app check line</None>}
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

export function Gate({ lap }: { lap: OneLapRow }): ReactElement {
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
                <span style={inkOf(stateOf(GATE_STATE, outcome))}>{outcome}</span>
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

/** A panel's rows as it last delivered them. */
export interface Lifted<Row> {
  rows: readonly Row[] | undefined;
  state: PanelState;
}

/** Hands a panel's rows up to the screen that draws them with another panel's rows. */
export function Lift<Row>({
  rows,
  state,
  onChange,
}: Lifted<Row> & { onChange: (lifted: Lifted<Row>) => void }): null {
  useEffect(() => onChange({ rows, state }), [rows, state, onChange]);
  return null;
}

/** The graph with its side panel, then every attempt as a row, folded away. */
export function LapStepsBody({
  rows,
  map,
  factory,
  workflow,
  now: fixed,
}: {
  rows: readonly StepAttemptRow[];
  factory: string;
  /** The run's workflow, whose map the graph is drawn from. */
  workflow: string;
  map: Lifted<LapMapRow>;
  /** A fixed clock, for tests; the screen uses the browser's. */
  now?: number;
}): ReactElement {
  const ticking = useNow();
  const now = fixed ?? ticking;
  const total = runCost(rows);
  // Until a map arrives the graph waits; a map that cannot load leaves the lap's own steps.
  const mapRows = map.state === 'error' ? [] : map.rows;
  const lap = useMemo(
    () => (mapRows === undefined ? undefined : lapGraph(mapRows, rows, factory, workflow)),
    [mapRows, rows, factory, workflow],
  );
  // undefined: follow the step running now; null: the panel was closed.
  const [picked, setPicked] = useState<string | null | undefined>(undefined);
  const running = lap?.graph.steps.filter((n) => lap.steps.get(n.id)?.state === 'running').at(-1);
  const selected = picked === undefined ? (running?.id ?? null) : picked;
  return (
    <div className="grid gap-4">
      <p className={`${MONO} flex flex-wrap gap-x-5 gap-y-1 text-text-secondary`}>
        <span>
          Run cost{' '}
          <span data-lap-cost={total ?? 0} className="text-text-primary">
            {formatCost(total ?? 0)}
          </span>
        </span>
        {rows.length === 0 ? <span>No step has started yet.</span> : null}
        {lap === undefined ? null : (
          <span data-lap-pin={lap.pin ?? undefined}>
            {!lap.mapped
              ? 'No map is stored for any pin: the steps the lap ran, in the order they started.'
              : lap.pin === null
                ? "The loop at the queue pack's own version"
                : `The loop at pin ${lap.pin.slice(0, 7)}`}
          </span>
        )}
      </p>
      {lap === undefined ? (
        <p className="text-sm text-text-secondary">Loading the lap's map.</p>
      ) : (
        <div data-lap-steps className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
          <div className="min-w-0">
            <LapGraphView lap={lap} now={now} selected={selected} onSelect={setPicked} />
          </div>
          <div className="lg:sticky lg:top-4">
            <StepPanel lap={lap} path={selected} now={now} onClose={() => setPicked(null)} />
          </div>
        </div>
      )}
      <details className="group">
        <summary
          className={`${MONO} w-fit cursor-pointer text-text-secondary underline decoration-dotted underline-offset-2 hover:text-text-primary`}
        >
          Every attempt, one row each ({rows.length})
        </summary>
        <div className="mt-3">
          <StepList rows={rows} now={now} />
        </div>
      </details>
    </div>
  );
}

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
  return (
    <div className="grid gap-3">
      <ol className={`${CARD} overflow-hidden`}>
        {sorted.map((attempt) => {
          const seconds = attemptSeconds(attempt, now);
          const cost = stepCost(attempt, rows);
          const status = stateOf(STEP_STATUS_STATE, attempt.status);
          const cache =
            attempt.tokens_cache_read === null && attempt.tokens_cache_write === null
              ? undefined
              : `cache read ${formatCount(attempt.tokens_cache_read ?? 0)}, cache write ${formatCount(attempt.tokens_cache_write ?? 0)}`;
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
                  style={status === undefined ? undefined : { backgroundColor: stateColor(status) }}
                />
                <span className="min-w-0 truncate text-text-primary">
                  {stepLabel(attempt.step_id)}
                </span>
                {attempt.outcome === null ? null : (
                  <span className="truncate text-text-secondary">{attempt.outcome}</span>
                )}
              </span>
              <span className={`${TAG} text-text-secondary`} style={inkOf(status)}>
                {attempt.status}
              </span>
              <span className="min-w-0 truncate text-text-secondary">
                {attempt.started_at === null ? (
                  <None>no start</None>
                ) : (
                  localSecond(attempt.started_at)
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
                  `${formatCount(attempt.tokens_input ?? 0)} / ${formatCount(attempt.tokens_output ?? 0)}`
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

export function CheckList({ rows }: { rows: readonly CheckLineRow[] }): ReactElement {
  const sorted = useMemo(() => linesInOrder(rows), [rows]);
  return (
    <ol className={`${CARD} overflow-hidden`}>
      {sorted.map((line) => (
        <li
          key={line.position}
          data-check-line
          data-position={line.position}
          data-line-id={line.line_id ?? undefined}
          data-kind={line.kind}
          data-verdict={line.verdict}
          data-evidence={line.evidence_count}
          className={`${MONO} grid grid-cols-[32px_40px_minmax(0,1fr)_auto] items-center gap-x-[18px] gap-y-1 border-b border-border/40 px-[18px] py-[11px] last:border-b-0 sm:grid-cols-[32px_40px_minmax(0,1fr)_72px_120px]`}
        >
          <span className="text-text-secondary">{line.position}</span>
          <span className="text-text-primary">{line.line_id ?? ''}</span>
          <span className="text-text-primary">{line.kind}</span>
          <span
            className={`${TAG} text-text-secondary`}
            style={inkOf(stateOf(VERDICT_STATE, line.verdict))}
          >
            {line.verdict}
          </span>
          <span className="col-span-3 text-text-secondary sm:col-span-1 sm:text-right">
            {line.evidence_count} evidence
          </span>
        </li>
      ))}
    </ol>
  );
}
