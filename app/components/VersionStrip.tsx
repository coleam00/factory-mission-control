import { type ReactElement, useEffect, useRef } from 'react';
import { Link, useSearchParams } from 'react-router';
import {
  compareLinks,
  NOT_RECORDED,
  SHARED_PROCESS,
  type StripEntry,
  scorecardLink,
  stripEntries,
  type VersionStripRow,
} from '../lib/version-strip';
import { LivePanel } from '../live/LivePanel';
import { EmptyState } from './EmptyState';

const LABEL = 'font-mono text-[10px] font-semibold uppercase tracking-[0.04em] text-text-secondary';
const MONO = 'font-mono text-[12px] tabular-nums';

/** The address's query parameter naming each selected version's digest, in the order picked. */
export const SELECT_PARAM = 'select';

/** `params` naming `digests` as the selection, in order, with every other parameter kept. */
export function withSelection(
  params: URLSearchParams,
  digests: readonly string[],
): URLSearchParams {
  const next = new URLSearchParams(params);
  next.delete(SELECT_PARAM);
  for (const digest of digests) next.append(SELECT_PARAM, digest);
  return next;
}

/**
 * The versions picked on the strip, read from and written to the address (`?select=<digest>`), so
 * Back, a reload or a shared link keeps them. Writing replaces the entry and keeps other parameters.
 */
export function useSelectedVersions(): [readonly string[], (digests: readonly string[]) => void] {
  const [params, setParams] = useSearchParams();
  // Picking is not a place to go Back to.
  const select = (digests: readonly string[]) =>
    setParams((was) => withSelection(was, digests), { replace: true });
  return [params.getAll(SELECT_PARAM), select];
}

/** One factory's versions, oldest first, each labelled by its pin; two picked compare. */
export function VersionStrip({ factory }: { factory: string | undefined }): ReactElement {
  const [selected, select] = useSelectedVersions();
  return (
    <LivePanel<VersionStripRow> query="version-strip" factory={factory}>
      {(rows, state) => (
        <>
          <h1 className={`${LABEL} mb-3`}>Versions</h1>
          {state === 'error' ? (
            <p className="text-sm text-text-secondary">Live data is unavailable.</p>
          ) : rows === undefined || factory === undefined ? (
            <p className="text-sm text-text-secondary">Loading versions.</p>
          ) : rows.length === 0 ? (
            <EmptyState title="No versions recorded for this factory yet." />
          ) : (
            <>
              <p data-shared className="mb-3 text-sm text-text-secondary">
                {SHARED_PROCESS}
              </p>
              <VersionList
                factory={factory}
                entries={stripEntries(rows)}
                selected={selected}
                onSelect={select}
              />
            </>
          )}
        </>
      )}
    </LivePanel>
  );
}

/** The picks after pressing `digest`'s select button: off if picked, else on, keeping the last two. */
export function toggleSelection(kept: readonly string[], digest: string): string[] {
  return kept.includes(digest) ? kept.filter((d) => d !== digest) : [...kept, digest].slice(-2);
}

export function VersionList({
  factory,
  entries,
  selected,
  onSelect,
}: {
  factory: string;
  entries: readonly StripEntry[];
  selected: readonly string[];
  onSelect: (digests: readonly string[]) => void;
}): ReactElement {
  const [params] = useSearchParams();
  const pin = params.get('pin');
  const digest = params.get('digest');
  const destination = entries.find(
    (entry) => pin !== null && entry.pin === pin && (digest === null || entry.digest === digest),
  );
  // A selection naming no version here (unknown, or another factory's) is ignored.
  const known = new Set(entries.flatMap((e) => (e.digest === null ? [] : [e.digest])));
  const kept = [...new Set(selected.filter((d) => known.has(d)))].slice(-2);
  const picked = entries.flatMap((e) =>
    e.digest !== null && kept.includes(e.digest) ? [e.digest] : [],
  );
  const onToggle = (digest: string) => onSelect(toggleSelection(kept, digest));
  const links = picked.length === 2 ? compareLinks(factory, picked[0], picked[1]) : undefined;
  // Guidance follows what can be picked: a pin not yet run has no digest and no select button.
  const selectable = known.size;
  return (
    <>
      <ol className="grid gap-3">
        {entries.map((entry, index) => (
          <Entry
            key={entry.digest ?? `pin:${entry.pin}`}
            entry={entry}
            after={daysBetween(entries[index - 1]?.date, entry.date)}
            last={index === entries.length - 1}
            targeted={entry === destination}
            selected={entry.digest !== null && kept.includes(entry.digest)}
            onToggle={onToggle}
          />
        ))}
      </ol>
      <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
        {links ? (
          <>
            <Link data-compare="scorecard" to={links.scorecard} className="text-accent-bright">
              Compare scorecards
            </Link>
            <Link data-compare="diff" to={links.diff} className="text-accent-bright">
              Diff the two versions
            </Link>
          </>
        ) : picked.length === 1 ? (
          <>
            <Link
              data-scorecard="one"
              to={scorecardLink(factory, picked[0])}
              className="text-accent-bright"
            >
              Open this version's scorecard
            </Link>
            <p className="text-text-secondary">
              {selectable < 2
                ? 'A comparison needs a second version that has run.'
                : 'Select another version to compare.'}
            </p>
          </>
        ) : selectable === 0 ? (
          <p className="text-text-secondary">
            No version has run yet, so there is nothing to compare.
          </p>
        ) : selectable === 1 ? (
          <p className="text-text-secondary">
            Only one version has run; a comparison needs a second.
          </p>
        ) : (
          <p className="text-text-secondary">Select two versions to compare.</p>
        )}
      </div>
    </>
  );
}

/** Whole days from one `YYYY-MM-DD` date to the next, or null when either is not recorded. */
export function daysBetween(from: string | undefined, to: string): number | null {
  const start = from === undefined ? Number.NaN : Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  return Number.isNaN(start) || Number.isNaN(end) ? null : Math.round((end - start) / 86_400_000);
}

/**
 * One version on the timeline: its date and pin on the rail, with the days since the version
 * before, and its card beside it. Oldest first, so the line reads as the factory's history.
 */
function Entry({
  entry,
  after,
  last,
  targeted,
  selected,
  onToggle,
}: {
  entry: StripEntry;
  /** Days since the version before this one, when both dates are known. */
  after: number | null;
  last: boolean;
  targeted: boolean;
  selected: boolean;
  onToggle: (digest: string) => void;
}): ReactElement {
  const { digest } = entry;
  const row = useRef<HTMLLIElement>(null);
  // The destination may arrive after navigation, in the first live snapshot.
  // Only scroll when it becomes the target, not on subsequent live updates.
  useEffect(() => {
    if (targeted) row.current?.scrollIntoView({ block: 'center' });
  }, [targeted]);
  const marked = selected || targeted;
  return (
    <li
      ref={row}
      aria-current={targeted ? 'true' : undefined}
      data-version-entry
      data-kind={digest === null ? 'pending' : 'version'}
      data-digest={digest ?? undefined}
      data-pin={entry.pin ?? undefined}
      className="grid grid-cols-[96px_minmax(0,1fr)] gap-x-4 sm:grid-cols-[132px_minmax(0,1fr)]"
    >
      <div className="relative pt-[13px]">
        {/* The rail: a line through every version, stopping at the newest. */}
        <span
          aria-hidden="true"
          className={`absolute top-0 right-[5px] w-px bg-border-bright ${last ? 'h-[22px]' : '-bottom-3'}`}
        />
        {/* Colors inline, as on the issue graph: `.console-root *` outranks border utilities. */}
        <span
          aria-hidden="true"
          className="absolute top-[16px] right-0 h-[11px] w-[11px] rounded-full border-2"
          style={{
            borderColor:
              digest === null
                ? 'var(--warning)'
                : marked
                  ? 'var(--selected)'
                  : 'var(--accent-bright)',
            backgroundColor: marked ? 'var(--selected)' : 'var(--background)',
          }}
        />
        <div className="flex flex-col items-start gap-0.5 pr-6">
          <span data-date={entry.date} className={`${MONO} font-semibold text-text-primary`}>
            {entry.date}
          </span>
          <span className={`${MONO} text-text-secondary`}>
            {entry.pin === null ? NOT_RECORDED : entry.pin.slice(0, 8)}
          </span>
          {after === null ? null : (
            <span className="font-mono text-[11px] text-text-secondary">
              {after === 0 ? 'same day' : `${after} ${after === 1 ? 'day' : 'days'} later`}
            </span>
          )}
        </div>
      </div>
      <div
        className={`flex min-w-0 flex-col gap-2 rounded-[10px] border border-border bg-surface px-[18px] py-[13px] ${
          marked ? 'bg-[color:var(--accent-soft)] ring-2 ring-inset ring-selected' : ''
        }`}
      >
        <div className="flex flex-wrap items-center gap-x-[18px] gap-y-1">
          {digest === null ? (
            <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.05em] text-warning">
              Not yet run
            </span>
          ) : (
            <span className={`${MONO} min-w-0 break-all text-text-secondary`}>
              {shortDigest(digest)}
            </span>
          )}
          {digest === null ? null : (
            <button
              type="button"
              aria-pressed={selected}
              aria-label={selectName(entry, digest, selected)}
              onClick={() => onToggle(digest)}
              className={`ml-auto font-mono text-[11px] font-semibold uppercase tracking-[0.1em] transition-colors ${
                selected ? 'text-text-primary' : 'text-text-secondary hover:text-text-primary'
              }`}
            >
              {selected ? `Selected ${entry.date}` : `Select ${entry.date}`}
            </button>
          )}
        </div>
        <p data-reason={entry.reason} className="min-w-0 break-words text-[14px] text-text-primary">
          {entry.reason}
        </p>
        <div className="grid gap-2 md:grid-cols-2">
          <div data-hypothesis={entry.hypothesis} className="min-w-0">
            <Trailer label="Hypothesis" text={entry.hypothesis} />
          </div>
          <div data-measure={entry.measure} className="min-w-0">
            <Trailer label="Measure" text={entry.measure} />
          </div>
        </div>
      </div>
    </li>
  );
}

const shortDigest = (digest: string) => digest.slice(0, 'sha256:'.length + 12);

/**
 * The select button's accessible name: its visible text, then the pin and short digest, since two
 * versions can share a pin and so a date.
 */
export function selectName(entry: StripEntry, digest: string, selected: boolean): string {
  const pin = entry.pin === null ? `pin ${NOT_RECORDED}` : `pin ${entry.pin.slice(0, 8)}`;
  return `${selected ? 'Selected' : 'Select'} ${entry.date}, ${pin}, ${shortDigest(digest)}`;
}

function Trailer({ label, text }: { label: string; text: string }): ReactElement {
  return (
    <>
      <div className={LABEL}>{label}</div>
      <p className="break-words text-[13px] text-text-secondary">{text}</p>
    </>
  );
}
