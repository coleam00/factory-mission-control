import type { ReactElement, ReactNode } from 'react';
import { Link } from 'react-router';
import {
  type LedgerRow,
  ledger,
  type TestingEntry,
  type TimelineRow,
  timelineEntries,
  type VerdictEntry,
} from '../lib/decisions-ledger';
import { NOT_RECORDED, SHARED_PROCESS } from '../lib/version-strip';
import { LivePanel, type PanelState } from '../live/LivePanel';
import { EmptyState } from './EmptyState';

const LABEL = 'font-mono text-[10px] font-semibold uppercase tracking-[0.04em] text-text-secondary';
const MONO = 'font-mono text-[12px] tabular-nums';
const BADGE =
  'shrink-0 rounded-full border px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-[0.04em]';
const ROW = 'flex flex-col gap-2 border-b border-border/40 px-[18px] py-[13px]';

const VERDICT_CLASS: Record<VerdictEntry['verdict'], string> = {
  helped: 'border-success/35 bg-success/[0.08] text-success',
  hurt: 'border-error/35 bg-error/[0.08] text-error',
  inconclusive: 'border-border-bright text-text-secondary',
};

/** The error and loading sentences both panels on this screen share. */
function PanelBody<Row>({
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

/**
 * `DECISIONS.md`, oldest first, each entry linked to the version its `Version:` line names. The
 * decisions are the shared factory process's; a factory with no laps gets none, and its empty state.
 */
export function DecisionsTimeline({ factory }: { factory: string | undefined }): ReactElement {
  return (
    <LivePanel<TimelineRow> query="decisions-timeline" factory={factory}>
      {(rows, state) =>
        rows?.length === 0 && state === 'ready' ? (
          <div data-decisions-empty>
            <EmptyState title="No decisions recorded for this factory yet." />
          </div>
        ) : (
          <>
            <h1 className={`${LABEL} mb-3`}>Key decisions</h1>
            <PanelBody rows={rows} state={state} factory={factory} what="decisions">
              {(loaded, name) => (
                <>
                  <p data-shared className="mb-3 text-sm text-text-secondary">
                    {SHARED_PROCESS}
                  </p>
                  <Timeline factory={name} entries={timelineEntries(loaded)} />
                </>
              )}
            </PanelBody>
          </>
        )
      }
    </LivePanel>
  );
}

export function Timeline({
  factory,
  entries,
}: {
  factory: string;
  entries: readonly TimelineRow[];
}): ReactElement {
  return (
    <ol className="overflow-hidden rounded-[10px] border border-border bg-surface [&>li:last-child]:border-b-0">
      {entries.map((entry) => (
        <li
          key={`${entry.date} ${entry.title}`}
          data-decision-entry
          data-date={entry.date}
          data-title={entry.title}
          data-pin={entry.pin_sha ?? undefined}
          className={ROW}
        >
          <div className="flex flex-wrap items-baseline gap-x-[18px] gap-y-1">
            <span className={`${MONO} text-text-primary`}>{entry.date}</span>
            <span className="min-w-0 break-words text-[13px] font-semibold text-text-primary">
              {entry.title}
            </span>
          </div>
          <p className="min-w-0 break-words text-[13px] text-text-primary">{entry.decision}</p>
          <div className="grid gap-2 md:grid-cols-2">
            <Trailer label="Why" text={entry.why} />
            <Trailer label="Replaces" text={entry.replaces} />
          </div>
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className={LABEL}>Version</span>
            {entry.pin_sha === null ? (
              <span className={`${MONO} min-w-0 break-all text-text-secondary`}>
                {entry.version},{' '}
                {entry.ambiguous
                  ? 'ambiguous: several pins by that prefix'
                  : 'no pin by that prefix'}
              </span>
            ) : (
              <Link
                data-version-link={entry.pin_sha}
                to={`/f/${encodeURIComponent(factory)}/versions?${new URLSearchParams({
                  pin: entry.pin_sha,
                  ...(entry.digest === null ? {} : { digest: entry.digest }),
                })}`}
                className={`${MONO} min-w-0 break-all text-accent-bright`}
              >
                {entry.pin_sha.slice(0, 8)}
                {entry.digest === null
                  ? ', not yet run'
                  : ` ${entry.digest.slice(0, 'sha256:'.length + 12)}`}
              </Link>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}

/** Pins awaiting a verdict with the laps each still waits for, and pins with a verdict. */
export function ImprovementsLedger({ factory }: { factory: string | undefined }): ReactElement {
  return (
    <LivePanel<LedgerRow> query="improvements-ledger" factory={factory}>
      {(rows, state) =>
        // No pins, or a factory with no laps: the timeline's empty state speaks for the screen.
        rows?.length === 0 && state === 'ready' ? null : (
          <>
            <h2 className={`${LABEL} mb-3`}>Improvements being tested</h2>
            <PanelBody rows={rows} state={state} factory={factory} what="the ledger">
              {(loaded) => <Ledger {...ledger(loaded)} />}
            </PanelBody>
          </>
        )
      }
    </LivePanel>
  );
}

export function Ledger({
  testing,
  verdicts,
}: {
  testing: readonly TestingEntry[];
  verdicts: readonly VerdictEntry[];
}): ReactElement {
  return (
    <div className="flex flex-col gap-6">
      <section data-ledger-group="testing">
        {testing.length === 0 ? (
          <p className="text-sm text-text-secondary">No version is awaiting a verdict.</p>
        ) : (
          <ol className="overflow-hidden rounded-[10px] border border-border bg-surface [&>li:last-child]:border-b-0">
            {testing.map((entry) => (
              <li
                key={entry.pin}
                data-ledger-entry
                data-pin={entry.pin}
                data-laps={entry.laps}
                data-waiting={entry.waiting}
                className={ROW}
              >
                <div className="flex flex-wrap items-baseline gap-x-[18px] gap-y-1">
                  <span className={`${MONO} text-text-secondary`}>{entry.pin.slice(0, 8)}</span>
                  <span className={`${BADGE} border-warning/35 bg-warning/[0.08] text-warning`}>
                    {entry.waiting === NOT_RECORDED
                      ? `Laps waiting: ${NOT_RECORDED}`
                      : `${entry.waiting} ${entry.waiting === 1 ? 'lap' : 'laps'} waiting`}
                  </span>
                  <span className={`${MONO} ml-auto text-text-secondary`}>
                    {entry.laps} laps run
                  </span>
                </div>
                {entry.waiting === NOT_RECORDED ? null : (
                  <LapsTowardVerdict laps={entry.laps} waiting={entry.waiting} />
                )}
                <p className="min-w-0 break-words text-[13px] text-text-primary">{entry.reason}</p>
                <Trailer label="Measure" text={entry.measure} />
              </li>
            ))}
          </ol>
        )}
      </section>
      <section data-ledger-group="verdicts">
        <h2 className={`${LABEL} mb-3`}>Verdicts</h2>
        {verdicts.length === 0 ? (
          <p className="text-sm text-text-secondary">No verdicts recorded yet.</p>
        ) : (
          <ol className="overflow-hidden rounded-[10px] border border-border bg-surface [&>li:last-child]:border-b-0">
            {verdicts.map((entry) => (
              <li
                key={entry.pin}
                data-ledger-entry
                data-pin={entry.pin}
                data-verdict={entry.verdict}
                data-sentence={entry.sentence}
                className={ROW}
              >
                <div className="flex flex-wrap items-baseline gap-x-[18px] gap-y-1">
                  <span className={`${MONO} text-text-secondary`}>{entry.pin.slice(0, 8)}</span>
                  <span className={`${BADGE} ${VERDICT_CLASS[entry.verdict]}`}>
                    {entry.verdict}
                  </span>
                  <span className={`${MONO} ml-auto text-text-secondary`}>{entry.date}</span>
                </div>
                <p className="min-w-0 break-words text-[13px] text-text-primary">{entry.reason}</p>
                <p className="min-w-0 break-words text-[13px] text-text-secondary">
                  {entry.sentence}
                </p>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}

/** Laps run toward the laps the measure wants before a verdict: a progress bar, not a count. */
function LapsTowardVerdict({ laps, waiting }: { laps: number; waiting: number }): ReactElement {
  const wanted = laps + waiting;
  const done = wanted === 0 ? 1 : laps / wanted;
  return (
    <div aria-hidden="true" className="flex items-center gap-3">
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-inset">
        <div
          className="h-full rounded-full"
          style={{
            width: `${Math.max(2, Math.min(100, done * 100))}%`,
            backgroundColor: waiting === 0 ? 'var(--success)' : 'var(--warning)',
          }}
        />
      </div>
      <span className={`${MONO} shrink-0 text-text-secondary`}>
        {laps} of {wanted}
      </span>
    </div>
  );
}

function Trailer({ label, text }: { label: string; text: string }): ReactElement {
  return (
    <div className="min-w-0">
      <div className={LABEL}>{label}</div>
      <p className="break-words text-[13px] text-text-secondary">{text}</p>
    </div>
  );
}
