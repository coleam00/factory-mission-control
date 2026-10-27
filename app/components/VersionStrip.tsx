import { type ReactElement, useEffect, useRef } from 'react';
import { Link, useSearchParams } from 'react-router';
import {
  compareLinks,
  NOT_RECORDED,
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
            <VersionList
              factory={factory}
              entries={stripEntries(rows)}
              selected={selected}
              onSelect={select}
            />
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
      <ol className="border-t border-border/40">
        {entries.map((entry) => (
          <Entry
            key={entry.digest ?? `pin:${entry.pin}`}
            entry={entry}
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

function Entry({
  entry,
  targeted,
  selected,
  onToggle,
}: {
  entry: StripEntry;
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
  return (
    <li
      ref={row}
      aria-current={targeted ? 'true' : undefined}
      data-version-entry
      data-kind={digest === null ? 'pending' : 'version'}
      data-digest={digest ?? undefined}
      data-pin={entry.pin ?? undefined}
      className={`flex flex-col gap-2 border-b border-border/40 px-[18px] py-[13px] ${
        selected || targeted ? 'bg-surface-hover ring-2 ring-inset ring-accent-bright/40' : ''
      }`}
    >
      <div className="flex flex-wrap items-center gap-x-[18px] gap-y-1">
        <span data-date={entry.date} className={`${MONO} text-text-primary`}>
          {entry.date}
        </span>
        <span className={`${MONO} text-text-secondary`}>
          {entry.pin === null ? NOT_RECORDED : entry.pin.slice(0, 8)}
        </span>
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
      <p data-reason={entry.reason} className="min-w-0 break-words text-[13px] text-text-primary">
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
