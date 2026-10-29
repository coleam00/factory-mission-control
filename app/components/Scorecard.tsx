import { type ReactElement, useEffect } from 'react';
import { Link, useNavigate } from 'react-router';
import { formatCost, formatNumber, formatSigned } from '../lib/format';
import {
  dataValue,
  difference,
  type Lap,
  type Measure,
  type Measured,
  MEASURES,
  meaningful,
  newestVersionWithLaps,
  type Scorecard as Card,
  isVersionOf,
  keptVersions,
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

type Side = 'a' | 'b';

/** Each version's color, so A and B read apart at a glance on every card. */
const SIDE_COLOR: Record<Side, string> = {
  a: 'var(--accent-bright)',
  b: 'var(--node-prompt)',
};

/**
 * What each measure is about, as a colored stripe on its card, and which way is better. Only a
 * rate says better or worse: a count grows with the laps a version ran, so its change is not
 * colored.
 */
const GROUP: Record<string, { color: string; better: 'up' | 'down' | null }> = {
  laps: { color: 'var(--accent-bright)', better: null },
  active_hours: { color: 'var(--accent-bright)', better: null },
  merges: { color: 'var(--node-loop)', better: null },
  merges_per_active_hour: { color: 'var(--node-loop)', better: 'up' },
  empty_laps: { color: 'var(--node-approval)', better: null },
  failed_laps: { color: 'var(--node-approval)', better: null },
  send_backs: { color: 'var(--node-approval)', better: null },
  gate_refusals: { color: 'var(--node-approval)', better: null },
  lap_hours_per_merge: { color: 'var(--node-prompt)', better: 'down' },
  app_check_share: { color: 'var(--node-prompt)', better: 'down' },
  cost_per_merge: { color: 'var(--node-prompt)', better: 'down' },
  new_holdout_catches: { color: 'var(--success)', better: null },
};
const groupOf = (key: string) => GROUP[key] ?? { color: 'var(--accent-bright)', better: null };
const tint = (color: string, transparent: number) =>
  `color-mix(in oklch, ${color}, transparent ${transparent}%)`;

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

/**
 * One factory's scorecard for version `a`, and `b` beside it when given, by pack digest. Opened by
 * the factory switcher (`switched`), `a` and `b` are another factory's: those this one ran are kept.
 */
export function Scorecard({
  factory,
  a,
  b,
  switched = false,
}: {
  factory: string | undefined;
  a: string | undefined;
  b: string | undefined;
  switched?: boolean;
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
          ) : switched ? (
            <SwitchedScorecard factory={factory} a={a} b={b} rows={rows} />
          ) : (
            <ScorecardView factory={factory} a={a} b={b} rows={rows} />
          )}
        </>
      )}
    </LivePanel>
  );
}

/**
 * The scorecard the switcher opened: the versions this factory ran of those the other factory's
 * scorecard showed (`keptVersions`), with the address rewritten in place to name only them.
 */
export function SwitchedScorecard({
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
  const kept = keptVersions(rows, a, b);
  const navigate = useNavigate();
  const search = new URLSearchParams(
    Object.entries(kept).filter((entry): entry is [string, string] => entry[1] !== undefined),
  ).toString();
  useEffect(() => {
    navigate({ search: search === '' ? '' : `?${search}` }, { replace: true });
  }, [navigate, search]);
  return <ScorecardView factory={factory} a={kept.a} b={kept.b} rows={rows} />;
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
  // No version named: open on the newest version a lap ran, and say so (#camera-polish).
  const picked = a || newestVersionWithLaps(rows);
  if (!picked) {
    return <EmptyState title="No lap has run on this factory yet." action={versionsLink} />;
  }
  if (!a) {
    const { pin } = versionPin(rows, picked);
    return (
      <>
        <p data-default-version={picked} className="mb-3 text-sm text-text-secondary">
          Showing the newest version with laps,{' '}
          <span className="font-mono tabular-nums text-text-primary">
            {pin === null ? short(picked) : pin.slice(0, 8)}
          </span>
          . {versionsLink} to pick or compare another.
        </p>
        <ScorecardView factory={factory} a={picked} b={undefined} rows={rows} />
      </>
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
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-stretch gap-3">
        {versions.map((v) => (
          <div
            key={v.side}
            className="relative min-w-56 overflow-hidden rounded-[10px] border bg-surface px-4 py-3 pl-5"
            style={{ borderColor: tint(SIDE_COLOR[v.side], 55) }}
          >
            <span
              aria-hidden="true"
              className="absolute inset-y-0 left-0 w-[3px]"
              style={{ background: SIDE_COLOR[v.side] }}
            />
            <VersionHeader version={v} />
          </div>
        ))}
        {versions.length === 2 ? (
          <p className="self-center text-sm text-text-secondary">
            Each card shows B against A, and says when too few laps back it.
          </p>
        ) : null}
      </div>
      <ol className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {MEASURES.map((measure) => (
          <MeasureRow key={measure.key} measure={measure} versions={versions} />
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
      <div className={LABEL} style={{ color: SIDE_COLOR[version.side] }}>
        Version {version.side.toUpperCase()}
      </div>
      <div className={`${MONO} text-[15px] font-semibold text-text-primary`}>
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
}: {
  measure: Measure;
  versions: readonly Version[];
}): ReactElement {
  const [a, b] = versions;
  const group = groupOf(measure.key);
  return (
    <li
      data-measure-row={measure.key}
      className="relative flex flex-col gap-3 overflow-hidden rounded-[10px] border bg-surface px-4 pb-3.5 pt-4"
      style={{ borderColor: tint(group.color, 70) }}
    >
      <span
        aria-hidden="true"
        className="absolute inset-x-0 top-0 h-[3px]"
        style={{ background: group.color }}
      />
      <div className="font-mono text-[11px] font-semibold uppercase tracking-[0.05em] text-text-primary">
        {measure.label}
      </div>
      <div className="flex flex-wrap gap-x-8 gap-y-2">
        {versions.map((v) => (
          <MeasureCell key={v.side} measure={measure} version={v} />
        ))}
      </div>
      {b ? (
        <Difference
          unit={measure.unit}
          better={group.better}
          a={a.card[measure.key]}
          b={b.card[measure.key]}
        />
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
        <span className={LABEL} style={{ color: SIDE_COLOR[version.side] }}>
          {version.side.toUpperCase()}
        </span>
        <span className={`${MONO} font-semibold text-text-primary text-[13px] md:text-[26px]`}>
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
  better,
  a,
  b,
}: {
  unit: Measure['unit'];
  better: 'up' | 'down' | null;
  a: Measured;
  b: Measured;
}): ReactElement {
  const d = difference(a, b);
  const value = d === null ? 'n/a' : formatSigned(d, written(unit));
  const isMeaningful = meaningful(a, b);
  // Better is green and worse red, whichever way the measure counts; no change, or a measure
  // that is neither, stays neutral.
  const verdict =
    d === null || d === 0 || better === null
      ? null
      : d > 0 === (better === 'up')
        ? 'var(--success)'
        : 'var(--error)';
  const color = verdict ?? 'var(--text-secondary)';
  return (
    <div
      data-difference={value}
      data-meaningful={isMeaningful}
      className="min-w-0 self-start rounded-md border px-2.5 py-1.5"
      style={{ borderColor: tint(color, 55), background: tint(color, 88) }}
    >
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className={LABEL}>B against A</span>
        <span
          className={`${MONO} font-semibold ${
            verdict === 'var(--success)'
              ? 'text-success'
              : verdict === 'var(--error)'
                ? 'text-error'
                : 'text-text-primary'
          } text-[13px]`}
        >
          {value}
        </span>
      </div>
      {isMeaningful ? null : (
        <div className="mt-1 font-mono text-[11px] font-semibold uppercase tracking-[0.05em] text-warning">
          not yet meaningful
        </div>
      )}
    </div>
  );
}
