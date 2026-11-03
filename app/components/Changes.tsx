import { type ReactElement, useMemo, useState } from 'react';
import { Link } from 'react-router';
import {
  type ChangeItem,
  changeTimeline,
  type Pair,
  previousDigest,
  resolvePair,
  selectableVersions,
  testingChip,
  togglePair,
} from '../lib/changes';
import type { LedgerRow, TimelineRow, VerdictEntry } from '../lib/decisions-ledger';
import { type ScorecardRow, versionPin } from '../lib/scorecard';
import {
  compareLinks,
  NOT_RECORDED,
  SHARED_PROCESS,
  type VersionStripRow,
} from '../lib/version-strip';
import { LivePanel, type PanelState } from '../live/LivePanel';
import { EmptyState } from './EmptyState';
import { Lift, type Lifted } from './OneLap';
import { ScorecardView } from './Scorecard';

const LABEL = 'font-mono text-[10px] font-semibold uppercase tracking-[0.04em] text-text-secondary';
const MONO = 'font-mono text-[12px] tabular-nums';

const tint = (color: string) => `color-mix(in oklch, ${color}, transparent 85%)`;

const short = (digest: string): string => digest.slice(0, 'sha256:'.length + 12);

type Chip = 'helped' | 'hurt' | 'inconclusive' | 'testing';

/** Colors go inline: `.console-root *` outranks border utilities. */
const CHIP_COLOR: Record<Chip, { fg: string; bg: string }> = {
  helped: { fg: 'var(--role-test)', bg: 'var(--role-test-soft)' },
  hurt: { fg: 'var(--error)', bg: tint('var(--error)') },
  inconclusive: { fg: 'var(--text-secondary)', bg: 'var(--surface-elevated)' },
  testing: { fg: 'var(--accent-bright)', bg: tint('var(--accent-bright)') },
};

const PIP_COLOR: Record<Chip | 'none', string> = {
  helped: 'var(--role-test)',
  hurt: 'var(--error)',
  inconclusive: 'var(--border-bright)',
  testing: 'var(--accent-bright)',
  none: 'var(--border-bright)',
};

const unmatchedText = (unmatched: 'ambiguous' | 'none'): string =>
  unmatched === 'ambiguous' ? 'ambiguous: several pins by that prefix' : 'no pin by that prefix';

function VerdictChip({ kind, text }: { kind: Chip; text: string }): ReactElement {
  const { fg, bg } = CHIP_COLOR[kind];
  return (
    <span
      data-chip={kind}
      className="inline-flex items-center gap-1.5 rounded-[5px] px-1.5 py-px font-mono text-[10.5px]"
      style={{ color: fg, background: bg }}
    >
      {kind === 'testing' ? (
        <span
          aria-hidden="true"
          className="h-1.5 w-1.5 rounded-full motion-safe:animate-pulse"
          style={{ background: fg }}
        />
      ) : null}
      {text}
    </span>
  );
}

/** One factory's versions, newest first, with their verdicts and decisions, and two compared. */
export function Changes({
  factory,
  a,
  b,
  onPick,
}: {
  factory: string | undefined;
  a: string | null;
  b: string | null;
  onPick: (pair: Pair) => void;
}): ReactElement {
  const [strip, setStrip] = useState<Lifted<VersionStripRow>>({
    rows: undefined,
    state: 'loading',
  });
  const [ledgerRows, setLedger] = useState<Lifted<LedgerRow>>({
    rows: undefined,
    state: 'loading',
  });
  const [decisions, setDecisions] = useState<Lifted<TimelineRow>>({
    rows: undefined,
    state: 'loading',
  });
  const [scorecard, setScorecard] = useState<Lifted<ScorecardRow>>({
    rows: undefined,
    state: 'loading',
  });
  const items = useMemo(
    () =>
      strip.rows === undefined || ledgerRows.rows === undefined || decisions.rows === undefined
        ? undefined
        : changeTimeline(strip.rows, ledgerRows.rows, decisions.rows),
    [strip.rows, ledgerRows.rows, decisions.rows],
  );
  const failed = [strip, ledgerRows, decisions].some((panel) => panel.state === 'error');
  return (
    <>
      <LivePanel<VersionStripRow> query="version-strip" factory={factory} className="contents">
        {(rows, state) => <Lift rows={rows} state={state} onChange={setStrip} />}
      </LivePanel>
      <LivePanel<LedgerRow> query="improvements-ledger" factory={factory} className="contents">
        {(rows, state) => <Lift rows={rows} state={state} onChange={setLedger} />}
      </LivePanel>
      <LivePanel<TimelineRow> query="decisions-timeline" factory={factory} className="contents">
        {(rows, state) => <Lift rows={rows} state={state} onChange={setDecisions} />}
      </LivePanel>
      <h1 className={`${LABEL} mb-3`}>Changes</h1>
      {failed ? (
        <p className="text-sm text-text-secondary">Live data is unavailable.</p>
      ) : items === undefined || factory === undefined ? (
        <p className="text-sm text-text-secondary">Loading changes.</p>
      ) : strip.rows?.length === 0 ? (
        <EmptyState title="No versions recorded for this factory yet." />
      ) : (
        <>
          <p className="mb-1 text-sm text-text-secondary">
            Did my last change to the factory help? Every version, newest first, with why it was
            made and its verdict, and the decisions made along the way.
          </p>
          <p data-shared className="mb-3 text-sm text-text-secondary">
            {SHARED_PROCESS}
          </p>
          <ChangeTimeline
            items={items}
            pair={resolvePair(items, scorecard.rows, a, b)}
            onPick={onPick}
          />
        </>
      )}
      <LivePanel<ScorecardRow> query="scorecard" factory={factory} className="mt-6 block">
        {(rows, state) => (
          <>
            <Lift rows={rows} state={state} onChange={setScorecard} />
            {items === undefined ||
            failed ||
            factory === undefined ||
            strip.rows?.length === 0 ? null : (
              <Comparison
                factory={factory}
                rows={rows}
                state={state}
                pair={resolvePair(items, rows, a, b)}
                selectable={selectableVersions(items)}
              />
            )}
          </>
        )}
      </LivePanel>
    </>
  );
}

export function ChangeTimeline({
  items,
  pair,
  onPick,
}: {
  items: readonly ChangeItem[];
  pair: Pair;
  onPick: (pair: Pair) => void;
}): ReactElement {
  return (
    <ol className="grid grid-cols-[72px_14px_minmax(0,1fr)] gap-x-3 rounded-[12px] border border-border bg-surface px-4 py-4 sm:grid-cols-[86px_14px_minmax(0,1fr)]">
      {items.map((item, index) => (
        <Row
          // biome-ignore lint/suspicious/noArrayIndexKey: the timeline is rebuilt whole from its rows
          key={index}
          item={item}
          items={items}
          pair={pair}
          onPick={onPick}
        />
      ))}
    </ol>
  );
}

/** The three columns of a timeline row: when, the pip, and what happened. */
function Row({
  item,
  items,
  pair,
  onPick,
}: {
  item: ChangeItem;
  items: readonly ChangeItem[];
  pair: Pair;
  onPick: (pair: Pair) => void;
}): ReactElement {
  if (item.kind === 'version') {
    return <VersionRow item={item} items={items} pair={pair} onPick={onPick} />;
  }
  if (item.kind === 'decision') {
    const { decision } = item;
    return (
      <Entry
        marker={{
          'data-change': item.kind,
          'data-date': decision.date,
          'data-title': decision.title,
          'data-pin': decision.pin_sha ?? undefined,
        }}
        when={decision.date}
        pip="var(--role-person)"
      >
        <DecisionBody
          decision={decision}
          note={`${decision.version}, ${unmatchedText(decision.ambiguous ? 'ambiguous' : 'none')}`}
        />
      </Entry>
    );
  }
  const { verdict } = item;
  return (
    <Entry
      marker={{
        'data-change': item.kind,
        'data-prefix': verdict.pin,
        'data-verdict': verdict.verdict,
      }}
      when={verdict.date}
      pip={PIP_COLOR[verdict.verdict]}
    >
      <VerdictLine verdict={verdict} />
      <p className={`${MONO} mt-1 text-text-secondary`}>
        {verdict.pin}, {unmatchedText(verdict.unmatched ?? 'none')}
      </p>
    </Entry>
  );
}

function Entry({
  marker,
  when,
  below,
  pip,
  children,
}: {
  marker: Record<string, string | undefined>;
  when: string;
  below?: string;
  pip: string;
  children: React.ReactNode;
}): ReactElement {
  return (
    <li {...marker} className="col-span-3 grid grid-cols-subgrid py-2.5">
      <div className="flex flex-col items-start gap-0.5">
        <span className={`${MONO} text-text-secondary`}>{when}</span>
        {below === undefined ? null : (
          <span className={`${MONO} font-semibold text-text-primary`}>{below}</span>
        )}
      </div>
      <span
        aria-hidden="true"
        className="mt-[5px] h-[9px] w-[9px] rounded-full"
        style={{ background: pip }}
      />
      <div className="flex min-w-0 flex-col gap-2">{children}</div>
    </li>
  );
}

function VerdictLine({ verdict }: { verdict: VerdictEntry }): ReactElement {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <VerdictChip kind={verdict.verdict} text={verdict.verdict} />
      <span className="min-w-0 break-words text-[13px] text-text-primary">{verdict.sentence}</span>
    </div>
  );
}

function VersionRow({
  item,
  items,
  pair,
  onPick,
}: {
  item: ChangeItem & { kind: 'version' };
  items: readonly ChangeItem[];
  pair: Pair;
  onPick: (pair: Pair) => void;
}): ReactElement {
  const { entry, verdict, testing, decisions } = item;
  const { digest } = entry;
  const pin8 = entry.pin === null ? NOT_RECORDED : entry.pin.slice(0, 8);
  const state: Chip | 'none' = verdict?.verdict ?? (testing === null ? 'none' : 'testing');
  const checked = digest !== null && (pair.a === digest || pair.b === digest);
  const previous = digest === null ? null : previousDigest(items, digest);
  return (
    <Entry
      marker={{
        'data-change': item.kind,
        'data-digest': digest ?? undefined,
        'data-pin': entry.pin ?? undefined,
        'data-verdict': state,
      }}
      when={entry.date}
      below={pin8}
      pip={PIP_COLOR[state]}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="min-w-0 break-words text-[14px] text-text-primary">{entry.reason}</span>
        {verdict ? (
          <VerdictChip kind={verdict.verdict} text={verdict.verdict} />
        ) : testing ? (
          <VerdictChip kind="testing" text={testingChip(testing)} />
        ) : null}
        {digest === null ? (
          <span className="ml-auto text-[12px] text-text-secondary">not yet run</span>
        ) : (
          <span className="ml-auto flex items-center gap-4 text-[12px] text-text-secondary">
            {previous === null ? null : (
              <button
                type="button"
                data-compare-previous={previous}
                onClick={() => onPick({ a: previous, b: digest })}
                className="text-accent-bright"
              >
                compare with previous
              </button>
            )}
            <label className="flex items-center gap-1.5">
              <input
                type="checkbox"
                className="accent-accent"
                checked={checked}
                onChange={() => onPick(togglePair(items, pair, digest))}
                aria-label={`Compare ${entry.date}, pin ${pin8}, ${short(digest)}`}
              />
              Compare
            </label>
          </span>
        )}
      </div>
      <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1">
        <Pairing label="Hypothesis" text={entry.hypothesis} />
        <Pairing label="Measure" text={entry.measure} />
        {verdict ? <Pairing label="Verdict" text={verdict.sentence} /> : null}
      </dl>
      {decisions.length === 0 ? null : (
        <ul className="flex flex-col gap-3 border-l border-border pl-3">
          {decisions.map((decision) => (
            <li
              key={`${decision.date}:${decision.title}`}
              data-change="decision"
              data-date={decision.date}
              data-title={decision.title}
              data-pin={decision.pin_sha ?? undefined}
              className="flex gap-2"
            >
              <span
                aria-hidden="true"
                className="mt-[5px] h-[9px] w-[9px] shrink-0 rounded-full"
                style={{ background: 'var(--role-person)' }}
              />
              <div className="flex min-w-0 flex-col gap-2">
                <DecisionBody decision={decision} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </Entry>
  );
}

function Pairing({ label, text }: { label: string; text: string }): ReactElement {
  return (
    <>
      <dt className={LABEL}>{label}</dt>
      <dd className="min-w-0 break-words text-[13px] text-text-secondary">{text}</dd>
    </>
  );
}

function DecisionBody({ decision, note }: { decision: TimelineRow; note?: string }): ReactElement {
  return (
    <>
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="text-[13px] font-semibold text-text-primary">{decision.title}</span>
        <span className={`${MONO} text-text-secondary`}>{decision.date}</span>
      </div>
      {note === undefined ? null : <p className={`${MONO} text-text-secondary`}>{note}</p>}
      <p className="break-words text-[13px] text-text-primary">{decision.decision}</p>
      <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1">
        <Pairing label="Why" text={decision.why} />
        <Pairing label="Replaces" text={decision.replaces} />
      </dl>
    </>
  );
}

/** The scorecard of the pair, under the timeline, with the way to the workflows that changed. */
export function Comparison({
  factory,
  rows,
  state,
  pair,
  selectable,
}: {
  factory: string;
  rows: readonly ScorecardRow[] | undefined;
  state: PanelState;
  pair: Pair & { isDefault: boolean };
  /** How many versions have run and so have a box to check. */
  selectable: number;
}): ReactElement | null {
  if (state === 'error') {
    return <p className="text-sm text-text-secondary">Live data is unavailable.</p>;
  }
  if (rows === undefined)
    return <p className="text-sm text-text-secondary">Loading the scorecard.</p>;
  if (pair.a === undefined) return null;
  const pin = (digest: string) => versionPin(rows, digest).pin?.slice(0, 8) ?? short(digest);
  return (
    <>
      <h2 className={`${LABEL} mb-3`}>Comparison</h2>
      {pair.isDefault ? (
        <p data-default-pair className="mb-3 text-sm text-text-secondary">
          Showing the newest version with laps,{' '}
          <span className="font-mono tabular-nums text-text-primary">{pin(pair.b ?? pair.a)}</span>
          {pair.b === undefined ? null : (
            <>
              , against the one before it,{' '}
              <span className="font-mono tabular-nums text-text-primary">{pin(pair.a)}</span>
            </>
          )}
          .
        </p>
      ) : null}
      <ScorecardView factory={factory} a={pair.a} b={pair.b} rows={rows} />
      {pair.b === undefined ? (
        <p className="mt-3 text-sm text-text-secondary">
          {selectable < 2
            ? 'Only one version has run; there is nothing to compare yet.'
            : 'Select another version to compare.'}
        </p>
      ) : (
        <p className="mt-3 text-sm text-text-secondary">
          See{' '}
          <Link
            data-compare="diff"
            to={compareLinks(factory, pair.a, pair.b).diff}
            className="text-accent-bright"
          >
            what changed in the workflows
          </Link>
          .
        </p>
      )}
    </>
  );
}
