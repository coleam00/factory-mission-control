import type { ReactElement } from 'react';
import { Link } from 'react-router';
import { formatCost, formatNumber, formatSigned } from '../lib/format';
import {
  dataValue,
  difference,
  type Lap,
  type Measure,
  type Measured,
  MEASURES,
  meaningful,
  type Scorecard as Card,
  isVersionOf,
  type ScorecardRow,
  scorecard,
  versionLaps,
  versionPin,
} from '../lib/scorecard';
import { NOT_RECORDED } from '../lib/version-strip';
import { LivePanel } from '../live/LivePanel';
import { EmptyState } from './EmptyState';

const LABEL = 'font-mono text-[10px] font-semibold uppercase tracking-[0.04em] text-text-secondary';
const MONO = 'font-mono text-[12px] tabular-nums';
const ROW = 'grid gap-x-[18px] gap-y-3 border-b border-border/40 px-[18px] py-[13px]';
const COLUMNS = {
  a: 'md:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]',
  ab: 'md:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)]',
};

type Side = 'a' | 'b';

interface Version {
  side: Side;
  digest: string;
  laps: readonly Lap[];
  card: Card;
  /** The version strip's label: the pin its mc.versions row is labelled by, and its first run. */
  pin: string | null;
  firstRunAt: Date | null;
}

const short = (digest: string): string => digest.slice(0, 'sha256:'.length + 12);

/** One factory's scorecard for version `a`, and `b` beside it when given, by pack digest. */
export function Scorecard({
  factory,
  a,
  b,
}: {
  factory: string | undefined;
  a: string | undefined;
  b: string | undefined;
}): ReactElement {
  return (
    <LivePanel<ScorecardRow> query="scorecard" factory={factory}>
      {(rows, state) => (
        <>
          <h1 className={`${LABEL} mb-3`}>Scorecard</h1>
          {state === 'error' ? (
            <p className="text-sm text-text-secondary">Live data is unavailable.</p>
          ) : rows === undefined || factory === undefined ? (
            <p className="text-sm text-text-secondary">Loading the scorecard.</p>
          ) : (
            <ScorecardView factory={factory} a={a} b={b} rows={rows} />
          )}
        </>
      )}
    </LivePanel>
  );
}

export function ScorecardView({
  factory,
  a,
  b,
  rows,
}: {
  factory: string;
  a: string | undefined;
  b: string | undefined;
  rows: readonly ScorecardRow[];
}): ReactElement {
  const versionsLink = (
    <Link to={`/f/${encodeURIComponent(factory)}/versions`} className="text-sm text-accent-bright">
      Open the versions
    </Link>
  );
  if (!a) {
    return (
      <EmptyState
        title="Pick a version on the versions screen to see its scorecard."
        action={versionsLink}
      />
    );
  }
  const sides = b
    ? ([
        ['a', a],
        ['b', b],
      ] as const)
    : ([['a', a]] as const);
  const unknown = [...new Set(sides.map(([, digest]) => digest))].filter(
    (digest) => !isVersionOf(rows, digest),
  );
  if (unknown.length > 0) {
    const [first, second] = unknown.map(short);
    return (
      <EmptyState
        title={
          second === undefined
            ? `${first} is not a version of this factory.`
            : `${first} and ${second} are not versions of this factory.`
        }
        action={versionsLink}
      />
    );
  }
  const versions = sides.map(([side, digest]): Version => {
    // A version no lap ran stays on screen: each measure rests on 0 laps, and every difference
    // with it is not yet meaningful (owner decision on #16).
    const laps = versionLaps(rows, digest);
    return { side, digest, laps, card: scorecard(laps), ...versionPin(rows, digest) };
  });
  const columns = versions.length === 2 ? COLUMNS.ab : COLUMNS.a;
  return (
    <div className="border-t border-border/40">
      <div className={`${ROW} ${columns}`}>
        <div className={`${LABEL} hidden md:block`}>Measure</div>
        {versions.map((v) => (
          <VersionHeader key={v.side} version={v} />
        ))}
        {versions.length === 2 ? (
          <div className={`${LABEL} hidden md:block`}>Difference, B against A</div>
        ) : null}
      </div>
      <ol>
        {MEASURES.map((measure) => (
          <MeasureRow key={measure.key} measure={measure} versions={versions} columns={columns} />
        ))}
      </ol>
    </div>
  );
}

/** Labelled as the versions screen labels it: the pin, then the date of its first run. */
function VersionHeader({ version }: { version: Version }): ReactElement {
  const first = version.firstRunAt;
  return (
    <div
      data-version={version.side}
      data-digest={version.digest}
      data-pin={version.pin ?? undefined}
      className="min-w-0"
    >
      <div className={LABEL}>Version {version.side.toUpperCase()}</div>
      <div className={`${MONO} text-text-primary`}>
        {version.pin === null ? NOT_RECORDED : version.pin.slice(0, 8)}
      </div>
      <div className={`${MONO} break-all text-text-secondary`}>{short(version.digest)}</div>
      {first ? (
        <div className={`${MONO} text-text-secondary`}>
          first run {first.toISOString().slice(0, 10)}
        </div>
      ) : null}
      {version.laps.length === 0 ? (
        <div className={`${MONO} text-text-secondary`}>no lap ran yet</div>
      ) : null}
    </div>
  );
}

function MeasureRow({
  measure,
  versions,
  columns,
}: {
  measure: Measure;
  versions: readonly Version[];
  columns: string;
}): ReactElement {
  const [a, b] = versions;
  return (
    <li data-measure-row={measure.key} className={`${ROW} ${columns}`}>
      <div className="font-mono text-[11px] font-semibold uppercase tracking-[0.05em] text-text-primary">
        {measure.label}
      </div>
      {versions.map((v) => (
        <MeasureCell key={v.side} measure={measure} version={v} />
      ))}
      {b ? (
        <Difference unit={measure.unit} a={a.card[measure.key]} b={b.card[measure.key]} />
      ) : null}
    </li>
  );
}

const written = (unit: Measure['unit']) => (unit === 'usd' ? formatCost : formatNumber);

function shown(measure: Measure, value: number | null): string {
  return value === null ? 'n/a' : written(measure.unit)(value);
}

function MeasureCell({ measure, version }: { measure: Measure; version: Version }): ReactElement {
  const measured = version.card[measure.key];
  const byId = new Map(version.laps.map((lap) => [lap.id, lap]));
  const n = measured.laps.length;
  return (
    <div
      data-version={version.side}
      data-digest={version.digest}
      data-measure={measure.key}
      data-value={dataValue(measured.value)}
      data-laps={n}
      className="min-w-0"
    >
      <div className="flex items-baseline gap-2">
        <span className={`${LABEL} md:hidden`}>{version.side.toUpperCase()}</span>
        <span className={`${MONO} text-[13px] text-text-primary`}>
          {shown(measure, measured.value)}
        </span>
      </div>
      <details className="mt-1">
        <summary
          className={`${MONO} cursor-pointer list-none text-[11px] text-text-secondary underline decoration-dotted underline-offset-2 hover:text-text-primary [&::-webkit-details-marker]:hidden`}
        >
          {n} {n === 1 ? 'lap' : 'laps'}
        </summary>
        <ol className="mt-2 flex flex-col gap-1">
          {measured.laps.map((id) => (
            <LapLine
              key={id}
              id={id}
              counted={measured.counted?.includes(id)}
              reasons={measure.key === 'gate_refusals' ? byId.get(id)?.refusals : undefined}
            />
          ))}
        </ol>
      </details>
    </div>
  );
}

function LapLine({
  id,
  counted,
  reasons,
}: {
  id: string;
  counted: boolean | undefined;
  reasons: readonly string[] | undefined;
}): ReactElement {
  return (
    <li data-lap={id} data-counted={counted || undefined} className="text-[11px] tabular-nums">
      <span
        className={`break-all font-mono ${counted ? 'text-text-primary' : 'text-text-secondary'}`}
      >
        {id}
      </span>
      {counted ? (
        <span className="ml-2 font-mono font-semibold uppercase tracking-[0.05em] text-success">
          counted
        </span>
      ) : null}
      {counted
        ? reasons?.map((reason, i) => (
            // A reason can repeat when the gate refused twice for the same thing.
            // biome-ignore lint/suspicious/noArrayIndexKey: the list never reorders
            <p key={i} className="break-words text-[12px] text-text-secondary">
              {reason}
            </p>
          ))
        : null}
    </li>
  );
}

function Difference({
  unit,
  a,
  b,
}: {
  unit: Measure['unit'];
  a: Measured;
  b: Measured;
}): ReactElement {
  const d = difference(a, b);
  const value = d === null ? 'n/a' : formatSigned(d, written(unit));
  const isMeaningful = meaningful(a, b);
  return (
    <div data-difference={value} data-meaningful={isMeaningful} className="min-w-0">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className={`${LABEL} md:hidden`}>B against A</span>
        <span className={`${MONO} text-[13px] text-text-primary`}>{value}</span>
      </div>
      {isMeaningful ? null : (
        <div className="mt-1 font-mono text-[11px] font-semibold uppercase tracking-[0.05em] text-warning">
          not yet meaningful
        </div>
      )}
    </div>
  );
}
