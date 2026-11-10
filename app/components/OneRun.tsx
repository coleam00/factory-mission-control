import { type ReactElement, type ReactNode, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useActionPending, useActionsEnabled, useStartAction } from './ActionToast';
import { formatCost, formatCount, shortRunId } from '../lib/format';
import type { LapMapRow } from '../lib/lap-graph';
import { durationOf, OUTCOME_LABEL, since } from '../lib/laps';
import {
  attemptSeconds,
  type CheckLineRow,
  consoleUrl,
  isOldLoop,
  issueUrl,
  lapOutcome,
  type OneLapRow,
  pullUrl,
  type StepAttemptRow,
} from '../lib/one-lap';
import {
  bodyOf,
  collapseSkipped,
  displayStep,
  failedAttempt,
  managerRead,
  type Round,
  runCost,
  runTimeline,
  runTitle,
  runTokens,
  skipReason,
  stepCost,
  type TimelineEntry,
  waitsForSlot,
} from '../lib/one-run';
import { placeAddress } from '../lib/places';
import { formatTook } from '../lib/runs';
import {
  LAP_OUTCOME_STATE,
  RUN_STATE,
  STATE_NAME,
  STEP_STATUS_STATE,
  type State,
  stateOf,
} from '../lib/states';
import { LivePanel } from '../live/LivePanel';
import { MONO, PanelBody, useNow } from './panel';
import { openManager } from './ManagerDock';
import { CheckList, Gate, type Lifted, Lift, LapStepsBody, Review } from './OneLap';
import { Button, buttonClass } from './ui/Button';
import { ErrorPanel } from './ui/ErrorPanel';
import { Pill } from './ui/StateDot';
import { Timeline, TimelineRow } from './ui/Timeline';

const LINK =
  'underline decoration-[color:var(--v3-line-2)] underline-offset-2 hover:text-[color:var(--v3-fg)]';

/** The run an address names is not in this factory: the id as typed, and nothing under it. */
export function NoRun({ runId }: { runId: string }): ReactElement {
  return (
    <p data-no-lap className="text-sm text-text-secondary [overflow-wrap:anywhere]">
      No run <span className={`${MONO} text-text-primary`}>{runId}</span> in this factory.
    </p>
  );
}

export const TABS = [
  { key: 'timeline', label: 'Timeline' },
  { key: 'steps', label: 'Steps' },
  { key: 'log', label: 'Log' },
  { key: 'artifacts', label: 'Artifacts' },
] as const;
export type TabKey = (typeof TABS)[number]['key'];

/** The tab an address names; the Timeline when it names none or one this page lacks. */
export const tabOf = (param: string | null): TabKey =>
  TABS.find((tab) => tab.key === param)?.key ?? 'timeline';

/**
 * One run of any workflow. Its four panels are live on every tab, so the head, the read and the
 * timeline come from the same rows as the Steps tab, and the map is there for skip reasons.
 */
export function OneRun({
  factory,
  runId,
}: {
  factory: string | undefined;
  runId: string;
}): ReactElement {
  return (
    <LivePanel<OneLapRow> query="one-lap" factory={factory} args={[runId]}>
      {(rows, state) => (
        <PanelBody rows={rows} state={state} factory={factory} what="the run">
          {(loaded, name) =>
            loaded[0] === undefined ? (
              <NoRun runId={runId} />
            ) : (
              <RunPanels lap={loaded[0]} factory={name} runId={runId} />
            )
          }
        </PanelBody>
      )}
    </LivePanel>
  );
}

function RunPanels({
  lap,
  factory,
  runId,
}: {
  lap: OneLapRow;
  factory: string;
  runId: string;
}): ReactElement {
  const [params] = useSearchParams();
  const [map, setMap] = useState<Lifted<LapMapRow>>({ rows: undefined, state: 'loading' });
  const [checks, setChecks] = useState<Lifted<CheckLineRow>>({ rows: undefined, state: 'loading' });
  return (
    <>
      <LivePanel<LapMapRow>
        query="one-lap-map"
        factory={factory}
        args={[runId]}
        className="contents"
      >
        {(rows, state) => <Lift rows={rows} state={state} onChange={setMap} />}
      </LivePanel>
      <LivePanel<StepAttemptRow> query="one-lap-steps" factory={factory} args={[runId]}>
        {(rows, state) => (
          <PanelBody rows={rows} state={state} factory={factory} what="the steps">
            {(loaded) => (
              <RunView
                lap={lap}
                rows={loaded}
                map={map}
                factory={factory}
                tab={tabOf(params.get('tab'))}
                checks={checks.state === 'ready' ? checks.rows : undefined}
                checksPanel={
                  <LivePanel<CheckLineRow> query="one-lap-checks" factory={factory} args={[runId]}>
                    {(lines, state) => (
                      <>
                        <Lift rows={lines} state={state} onChange={setChecks} />
                        <PanelBody
                          rows={lines}
                          state={state}
                          factory={factory}
                          what="the app check"
                        >
                          {(loadedLines) =>
                            loadedLines.length === 0 ? (
                              <p className="text-sm text-text-secondary">
                                No app check has reported on this run.
                              </p>
                            ) : (
                              <CheckList rows={loadedLines} />
                            )
                          }
                        </PanelBody>
                      </>
                    )}
                  </LivePanel>
                }
              />
            )}
          </PanelBody>
        )}
      </LivePanel>
    </>
  );
}

export interface RunViewProps {
  lap: OneLapRow;
  rows: readonly StepAttemptRow[];
  map: Lifted<LapMapRow>;
  factory: string;
  tab: TabKey;
  /** The run's app-check lines once loaded; until then no disposition is matched. */
  checks?: readonly CheckLineRow[];
  /** The Steps tab's app check lines. */
  checksPanel: ReactNode;
  /** A fixed clock, for tests; the screen uses the browser's. */
  now?: number;
  /** Render the skipped-step groups expanded, for tests that cannot click. */
  skippedOpen?: boolean;
}

/** The run's page for a tab: head, the manager's read, the tabs and the one tab's body. */
export function RunView({
  lap,
  rows,
  map,
  factory,
  tab,
  checks,
  checksPanel,
  now: fixed,
  skippedOpen = false,
}: RunViewProps): ReactElement {
  const ticking = useNow();
  const now = fixed ?? ticking;
  const timeline = runTimeline(rows);
  const mapRows = map.state === 'error' || map.rows === undefined ? [] : map.rows;
  const consoleHref = consoleUrl(lap.console, lap.run_id);
  return (
    <div className="grid gap-5">
      <RunHead
        lap={lap}
        rows={rows}
        timeline={timeline}
        factory={factory}
        consoleHref={consoleHref}
        now={now}
      />
      <ManagerRead lap={lap} rows={rows} timeline={timeline} />
      <Tabs />
      {tab === 'timeline' ? (
        <RunTimeline
          stopAttempt={lap.status === 'failed' ? failedAttempt(rows, lap.stop_step) : null}
          rows={rows}
          timeline={timeline}
          map={mapRows}
          consoleHref={consoleHref}
          resume={{ factory, runId: lap.run_id }}
          now={now}
          skippedOpen={skippedOpen}
        />
      ) : tab === 'steps' ? (
        <div className="grid gap-8">
          <LapStepsBody
            rows={rows}
            map={map}
            factory={factory}
            workflow={lap.workflow_name}
            now={now}
          />
          {isOldLoop(lap.workflow_name) ? (
            <div className="grid gap-6 sm:grid-cols-2">
              <Review lap={lap} checks={checks} />
              <Gate lap={lap} />
            </div>
          ) : null}
          <section className="grid gap-3">
            <h2 className="font-mono text-[11px] font-semibold tracking-[0.05em] text-text-secondary uppercase">
              App check
            </h2>
            {checksPanel}
          </section>
        </div>
      ) : (
        <p className="text-[length:var(--v3-t-body)] text-[color:var(--v3-fg-2)]">
          The {tab === 'log' ? 'run’s log' : 'run’s artifacts'} open in the{' '}
          <a data-link="console-tab" href={consoleHref} className={LINK}>
            Archon console
          </a>
          .
        </p>
      )}
    </div>
  );
}

function Tabs(): ReactElement {
  const [params] = useSearchParams();
  const current = tabOf(params.get('tab'));
  return (
    <div role="tablist" className="flex gap-0.5 border-b border-[color:var(--v3-line)]">
      {TABS.map((tab) => (
        <Link
          key={tab.key}
          role="tab"
          aria-selected={tab.key === current}
          replace
          to={tab.key === 'timeline' ? '?' : `?tab=${tab.key}`}
          className={`-mb-px border-b-2 px-3 py-2 text-[length:var(--v3-t-body)] ${
            tab.key === current
              ? 'border-[color:var(--v3-you)] text-[color:var(--v3-fg)]'
              : 'border-transparent text-[color:var(--v3-fg-2)] hover:text-[color:var(--v3-fg)]'
          }`}
        >
          {tab.label}
        </Link>
      ))}
    </div>
  );
}

/** The state a run's pill shows, and its words. */
function runPill(lap: OneLapRow): { state: State | undefined; name: string } {
  const outcome = isOldLoop(lap.workflow_name) ? lapOutcome(lap) : null;
  if (outcome !== null) return { state: LAP_OUTCOME_STATE[outcome], name: OUTCOME_LABEL[outcome] };
  if (waitsForSlot(lap)) return { state: 'idle', name: 'Waiting for a slot' };
  const state = stateOf(RUN_STATE, lap.status);
  return {
    state,
    name: lap.status === 'cancelled' ? 'Cancelled' : state ? STATE_NAME[state] : lap.status,
  };
}

/** The title with the issue number in it as a link to the issue. */
function Title({ lap, title }: { lap: OneLapRow; title: string }): ReactElement {
  const tag = lap.issue_number === null ? '' : `#${lap.issue_number}`;
  const at = tag === '' ? -1 : title.indexOf(tag);
  if (at < 0) return <>{title}</>;
  return (
    <>
      {title.slice(0, at)}
      <a
        data-link="issue"
        href={lap.issue_url ?? issueUrl(lap.repository, lap.issue_number as number)}
        className={LINK}
      >
        {tag}
      </a>
      {title.slice(at + tag.length)}
    </>
  );
}

function RunHead({
  lap,
  rows,
  timeline,
  factory,
  consoleHref,
  now,
}: {
  lap: OneLapRow;
  rows: readonly StepAttemptRow[];
  timeline: readonly TimelineEntry[];
  factory: string;
  consoleHref: string;
  now: number;
}): ReactElement {
  const title = runTitle(lap, timeline);
  const pill = runPill(lap);
  const pr = lap.pr_number;
  const cost = runCost(rows);
  const tokens = runTokens(rows);
  const seconds = lap.status === 'running' ? since(lap.started_at, now) : durationOf(lap);
  const outcome = isOldLoop(lap.workflow_name) ? lapOutcome(lap) : null;
  const read = managerRead(lap, rows, timeline);
  const enabled = useActionsEnabled(factory);
  const start = useStartAction();
  const pending = useActionPending();
  const primary =
    lap.status === 'failed' && read.resumeStep !== null
      ? `Resume from ${read.resumeStep}`
      : lap.status === 'paused' && lap.stop_step !== null && !waitsForSlot(lap)
        ? 'Answer in console'
        : null;
  return (
    <div
      data-lap={lap.run_id}
      data-workflow={lap.workflow_name}
      data-title={title}
      data-status={lap.status}
      data-outcome={outcome ?? undefined}
      data-route={lap.route ?? undefined}
      data-depth={lap.depth ?? undefined}
      data-issue={lap.issue_number ?? undefined}
      data-pr={pr ?? undefined}
      data-run-cost={cost ?? undefined}
      data-run-tokens={tokens ?? undefined}
    >
      <div className="mb-2 text-[length:var(--v3-t-meta)] text-[color:var(--v3-fg-3)]">
        <Link to={placeAddress(factory, 'runs')} className={LINK}>
          Runs
        </Link>{' '}
        › <span className="font-mono">{shortRunId(lap.run_id)}</span>
      </div>
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3 min-[760px]:flex-nowrap">
        <div className="min-w-0 min-[760px]:flex-1">
          <h1 className="m-0 text-[length:var(--v3-t-title)] leading-tight font-semibold text-[color:var(--v3-fg)] [overflow-wrap:anywhere]">
            <Title lap={lap} title={title} />
          </h1>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[length:var(--v3-t-meta)] text-[color:var(--v3-fg-2)]">
            <Pill state={pill.state} live={lap.status === 'running'}>
              {pill.name}
            </Pill>
            <span className="font-mono">{lap.workflow_name}</span>
            {pr === null ? null : (
              <>
                ·
                <a data-link="pr" href={pullUrl(lap.repository, pr)} className={LINK}>
                  PR #{pr}
                </a>
              </>
            )}
            ·
            <span data-duration className="tabular-nums">
              {seconds === null ? 'not recorded' : formatTook(seconds)} ·{' '}
              {cost === null ? '-' : formatCost(cost)} ·{' '}
              {tokens === null ? '-' : `${formatCount(tokens)} tokens in`}
            </span>
          </div>
        </div>
        <div className="flex shrink-0 gap-2">
          {primary === null ? null : enabled &&
            read.resumeFrom !== null &&
            lap.status === 'failed' ? (
            <Button
              variant="primary"
              disabled={pending}
              data-action="primary"
              data-act="resume"
              data-act-run={lap.run_id}
              onClick={() =>
                start(
                  {
                    factory,
                    action: 'resume',
                    run_id: lap.run_id,
                    from_step: read.resumeFrom,
                  },
                  { item: null, label: '' },
                )
              }
            >
              {primary}
            </Button>
          ) : (
            <a data-action="primary" href={consoleHref} className={buttonClass('primary')}>
              {primary}
            </a>
          )}
          <a
            data-link="console"
            href={consoleHref}
            className={`${buttonClass('secondary')} max-[759.98px]:hidden`}
          >
            Open in console
          </a>
        </div>
      </div>
    </div>
  );
}

function ManagerRead({
  lap,
  rows,
  timeline,
}: {
  lap: OneLapRow;
  rows: readonly StepAttemptRow[];
  timeline: readonly TimelineEntry[];
}): ReactElement {
  const read = managerRead(lap, rows, timeline);
  return (
    <div
      data-manager-read
      data-stop-class={read.stopClass ?? undefined}
      data-code-failure={read.codeFailure}
      data-resume-step={read.resumeStep ?? undefined}
      data-resume-cost={read.resumeCost ?? undefined}
      className="rounded-[var(--v3-radius-card)] border border-[color:var(--v3-you-line)] bg-[var(--v3-you-wash)] px-4 py-3.5"
    >
      <div className="mb-1.5 flex items-center gap-2 text-[13.5px] font-semibold text-[color:var(--v3-you-2)]">
        <span
          aria-hidden="true"
          className="grid size-5 place-items-center rounded-[5px] border border-[color:var(--v3-you-line)] font-mono text-[length:var(--v3-t-micro)]"
        >
          A
        </span>
        Manager's read
      </div>
      <p className="m-0 text-[length:var(--v3-t-body)] leading-[1.55] text-[color:var(--v3-fg)] [overflow-wrap:anywhere]">
        {read.parts.map((part, i) =>
          part.bold ? (
            // biome-ignore lint/suspicious/noArrayIndexKey: the parts are a fixed sentence
            <b key={i}>{part.text}</b>
          ) : (
            // biome-ignore lint/suspicious/noArrayIndexKey: the parts are a fixed sentence
            <span key={i}>{part.text}</span>
          ),
        )}
      </p>
    </div>
  );
}

const stateOfAttempt = (row: StepAttemptRow): State =>
  stateOf(STEP_STATUS_STATE, row.status) ?? 'idle';

const seconds = (value: number | null) => (value === null ? undefined : formatTook(value));
const money = (value: number | null) => (value === null ? undefined : formatCost(value));

function RunTimeline({
  stopAttempt,
  rows,
  timeline,
  map,
  consoleHref,
  resume,
  now,
  skippedOpen,
}: {
  stopAttempt: StepAttemptRow | null;
  rows: readonly StepAttemptRow[];
  timeline: readonly TimelineEntry[];
  map: readonly LapMapRow[];
  consoleHref: string;
  /** Which run a failed step resumes. */
  resume: { factory: string; runId: string };
  now: number;
  skippedOpen: boolean;
}): ReactElement {
  if (timeline.length === 0) {
    return <p className="text-sm text-text-secondary">No step has started yet.</p>;
  }
  const top = timeline.flatMap((entry) => (entry.kind === 'step' ? [entry.row] : []));
  const step = (row: StepAttemptRow, name: string, nested: boolean, why?: string | null) => {
    const skipped = row.status === 'skipped';
    const elapsed = attemptSeconds(row, now);
    const cost = stepCost(row, rows);
    return (
      <TimelineRow
        key={`${row.step_id} ${row.started_at?.toISOString() ?? row.status}`}
        state={stateOfAttempt(row)}
        name={name}
        hint={why ?? undefined}
        nested={nested}
        time={skipped ? undefined : seconds(elapsed)}
        cost={skipped ? undefined : money(cost)}
        data-timeline-step={row.step_id}
        data-status={row.status}
        data-started={row.started_at?.toISOString()}
        data-duration-ms={row.duration_ms?.toString()}
        data-cost={cost?.toString()}
      >
        {row === stopAttempt ? (
          <FailedStep row={row} consoleHref={consoleHref} resume={resume} />
        ) : null}
      </TimelineRow>
    );
  };
  const steps = (
    list: readonly StepAttemptRow[],
    scope: readonly StepAttemptRow[],
    name: (row: StepAttemptRow) => string,
    nested: boolean,
  ) =>
    collapseSkipped(list, (row) => row.status === 'skipped').map((item) =>
      'skipped' in item ? (
        <SkippedSteps
          key={`skipped ${item.skipped[0]?.step_id}`}
          nested={nested}
          initiallyOpen={skippedOpen}
        >
          {item.skipped.map((row) => step(row, name(row), nested, skipReason(row, scope, map)))}
        </SkippedSteps>
      ) : (
        step(item, name(item), nested)
      ),
    );
  return (
    <Timeline>
      {collapseSkipped(
        timeline,
        (entry) => entry.kind === 'step' && entry.row.status === 'skipped',
      ).map((group) => {
        if ('skipped' in group) {
          const rows = group.skipped.flatMap((entry) => (entry.kind === 'step' ? [entry.row] : []));
          return (
            <SkippedSteps
              key={`skipped ${rows[0]?.step_id}`}
              nested={false}
              initiallyOpen={skippedOpen}
            >
              {rows.map((row) => step(row, row.step_id, false, skipReason(row, top, map)))}
            </SkippedSteps>
          );
        }
        const entry = group;
        if (entry.kind === 'step') return step(entry.row, entry.row.step_id, false);
        const ownSeconds = entry.row === null ? null : attemptSeconds(entry.row, now);
        const roundMs = entry.rounds.map((r) => r.durationMs).filter((ms) => ms !== null);
        const span =
          ownSeconds ?? (roundMs.length === 0 ? null : roundMs.reduce((a, b) => a + b, 0) / 1000);
        const state: State = entry.rounds.some((r) => r.failed)
          ? 'failed'
          : entry.rounds.some((r) => r.running)
            ? 'running'
            : 'done';
        return [
          <TimelineRow
            key={`loop ${entry.group}`}
            state={state}
            name={entry.group}
            hint={`loop · ${entry.rounds.length} ${entry.rounds.length === 1 ? 'round' : 'rounds'}`}
            time={seconds(span)}
            data-loop={entry.group}
          />,
          ...entry.rounds.flatMap((round) =>
            round.failed || round.running || round.n === entry.rounds.length ? (
              steps(
                round.rows,
                round.rows,
                (row) => `round ${round.n} · ${displayStep(row.step_id)}`,
                true,
              )
            ) : (
              <FoldedRound key={`${entry.group} ${round.n}`} round={round} />
            ),
          ),
        ];
      })}
    </Timeline>
  );
}

/** Consecutive skipped steps as one muted row that opens to the steps and their recorded reasons. */
function SkippedSteps({
  nested,
  initiallyOpen,
  children,
}: {
  nested: boolean;
  initiallyOpen: boolean;
  children: ReactNode[];
}): ReactElement {
  const [open, setOpen] = useState(initiallyOpen);
  const toggle = () => setOpen((was) => !was);
  return (
    <>
      <TimelineRow
        state="idle"
        nested={nested}
        prose
        name={`${children.length} skipped`}
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={toggle}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            toggle();
          }
        }}
        data-skipped-count={String(children.length)}
      />
      {open ? children : null}
    </>
  );
}

function FoldedRound({ round }: { round: Round }): ReactElement {
  return (
    <TimelineRow
      state="done"
      nested
      name={`round ${round.n}`}
      hint={round.rows.map((row) => bodyOf(row.step_id)?.body ?? row.step_id).join(' → ')}
      time={seconds(round.durationMs === null ? null : round.durationMs / 1000)}
      cost={money(round.cost)}
      data-round={String(round.n)}
      data-round-cost={round.cost?.toString()}
      data-duration-ms={round.durationMs?.toString()}
    />
  );
}

function FailedStep({
  row,
  consoleHref,
  resume,
}: {
  row: StepAttemptRow;
  consoleHref: string;
  resume: { factory: string; runId: string };
}): ReactElement {
  const enabled = useActionsEnabled(resume.factory);
  const start = useStartAction();
  const pending = useActionPending();
  const [title = 'The step failed', ...rest] = (row.error ?? '').split(/\r?\n/);
  return (
    <div data-error-panel>
      <ErrorPanel
        title={title.trim() || 'The step failed'}
        error={rest.join('\n').trim() || 'No further detail was recorded.'}
        actions={
          <>
            {enabled ? (
              <Button
                variant="primary"
                disabled={pending}
                data-act="resume"
                data-act-run={resume.runId}
                onClick={() =>
                  start(
                    {
                      factory: resume.factory,
                      action: 'resume',
                      run_id: resume.runId,
                      from_step: row.step_id,
                    },
                    { item: null, label: '' },
                  )
                }
              >
                Resume from here
              </Button>
            ) : (
              <a href={consoleHref} className={buttonClass('primary')}>
                Resume from here
              </a>
            )}
            <a href={consoleHref} className={buttonClass('secondary')}>
              Open transcript
            </a>
            <Button variant="text" onClick={() => openManager()}>
              Ask manager
            </Button>
          </>
        }
      />
    </div>
  );
}
