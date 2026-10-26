import { type ReactElement, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import {
  compareLinks,
  NOT_RECORDED,
  type StripEntry,
  stripEntries,
  type VersionStripRow,
} from '../lib/version-strip';
import { LivePanel } from '../live/LivePanel';
import { EmptyState } from './EmptyState';

const LABEL = 'font-mono text-[10px] font-semibold uppercase tracking-[0.04em] text-text-secondary';
const MONO = 'font-mono text-[12px] tabular-nums';

/** One factory's versions, oldest first, each labelled by its pin; two picked compare. */
export function VersionStrip({ factory }: { factory: string | undefined }): ReactElement {
  const [selected, setSelected] = useState<readonly string[]>([]);
  const toggle = (digest: string) =>
    setSelected((was) =>
      was.includes(digest) ? was.filter((d) => d !== digest) : [...was, digest].slice(-2),
    );
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
              onToggle={toggle}
            />
          )}
        </>
      )}
    </LivePanel>
  );
}

export function VersionList({
  factory,
  entries,
  selected,
  onToggle,
}: {
  factory: string;
  entries: readonly StripEntry[];
  selected: readonly string[];
  onToggle: (digest: string) => void;
}): ReactElement {
  const [params] = useSearchParams();
  const pin = params.get('pin');
  const digest = params.get('digest');
  const destination = entries.find(
    (entry) => pin !== null && entry.pin === pin && (digest === null || entry.digest === digest),
  );
  const picked = entries.flatMap((e) =>
    e.digest !== null && selected.includes(e.digest) ? [e.digest] : [],
  );
  const links = picked.length === 2 ? compareLinks(factory, picked[0], picked[1]) : undefined;
  return (
    <>
      <ol className="border-t border-border/40">
        {entries.map((entry) => (
          <Entry
            key={entry.digest ?? `pin:${entry.pin}`}
            entry={entry}
            targeted={entry === destination}
            selected={entry.digest !== null && selected.includes(entry.digest)}
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
            {digest.slice(0, 'sha256:'.length + 12)}
          </span>
        )}
        {digest === null ? null : (
          <button
            type="button"
            aria-pressed={selected}
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

function Trailer({ label, text }: { label: string; text: string }): ReactElement {
  return (
    <>
      <div className={LABEL}>{label}</div>
      <p className="break-words text-[13px] text-text-secondary">{text}</p>
    </>
  );
}
