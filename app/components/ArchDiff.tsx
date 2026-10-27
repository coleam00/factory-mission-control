import type { ReactElement, ReactNode } from 'react';
import { Link } from 'react-router';
import {
  type ArchDiffRow,
  type DiffResult,
  diffVersions,
  type Item,
  itemLabel,
  KINDS,
  type Kind,
  type KindDiff,
} from '../lib/arch-diff';
import { LivePanel } from '../live/LivePanel';
import { EmptyState } from './EmptyState';

const LABEL = 'font-mono text-[10px] font-semibold uppercase tracking-[0.04em] text-text-secondary';
const MONO = 'font-mono text-[12px] tabular-nums';

const TITLES: Record<Kind, string> = {
  workflow: 'Workflows',
  step: 'Steps',
  prompt: 'Prompts',
  subagent: 'Subagents',
};
const CHANGES = ['added', 'removed', 'changed'] as const;
const MARKS: Record<(typeof CHANGES)[number], string> = { added: '+', removed: '−', changed: '~' };

const short = (digest: string) => digest.slice(0, 'sha256:'.length + 12);

/** What changed in one factory's architecture from version `a` to version `b`, by digest. */
export function ArchDiff({
  factory,
  a,
  b,
}: {
  factory: string | undefined;
  a: string | null;
  b: string | null;
}): ReactElement {
  const versions =
    factory === undefined ? undefined : (
      <Link to={`/f/${encodeURIComponent(factory)}/versions`} className="text-accent-bright">
        Versions
      </Link>
    );
  return (
    <LivePanel<ArchDiffRow> query="arch-diff" factory={factory}>
      {(rows, state) => (
        <>
          <h1 className={`${LABEL} mb-3`}>Architecture diff</h1>
          {a === null || b === null ? (
            <EmptyState title="Pick two versions to diff." action={versions} />
          ) : (
            <>
              <p className={`${MONO} mb-4 break-all text-text-secondary`}>
                <span data-version="a">{short(a)}</span> → <span data-version="b">{short(b)}</span>
              </p>
              {state === 'error' ? (
                <p className="text-sm text-text-secondary">Live data is unavailable.</p>
              ) : rows === undefined ? (
                <p className="text-sm text-text-secondary">Loading the architecture.</p>
              ) : (
                <DiffView result={diffVersions(rows, a, b)} versions={versions} />
              )}
            </>
          )}
        </>
      )}
    </LivePanel>
  );
}

export function DiffView({
  result,
  versions,
}: {
  result: DiffResult;
  versions?: ReactNode;
}): ReactElement {
  if (result.status === 'not-found') {
    const [first, second] = result.digests.map(short);
    return (
      <EmptyState
        title={
          second === undefined
            ? `${first} is not a version of this factory.`
            : `${first} and ${second} are not versions of this factory.`
        }
        action={versions}
      />
    );
  }
  if (result.status === 'unrecorded') {
    return (
      <EmptyState
        title={`No architecture is recorded for ${result.digests.map(short).join(' or ')}.`}
      />
    );
  }
  if (result.changes === 0) {
    return <EmptyState title="The two versions have the same architecture." />;
  }
  return (
    <div className="grid gap-6">
      {KINDS.map((kind) => (
        <KindSection key={kind} kind={kind} diff={result.diff[kind]} />
      ))}
    </div>
  );
}

function KindSection({ kind, diff }: { kind: Kind; diff: KindDiff }): ReactElement {
  const items = CHANGES.flatMap((change) => diff[change].map((item) => ({ change, item })));
  return (
    <section data-kind={kind}>
      <h2 className={`${LABEL} mb-2`}>
        {TITLES[kind]} <span className="tabular-nums">{items.length}</span>
      </h2>
      {items.length === 0 ? (
        <p className="border-t border-border/40 px-[18px] py-[10px] text-[13px] text-text-secondary">
          No change.
        </p>
      ) : (
        <ul className="border-t border-border/40">
          {items.map(({ change, item }) => (
            <Row key={`${change}:${itemLabel(item)}`} change={change} item={item} />
          ))}
        </ul>
      )}
    </section>
  );
}

function Row({ change, item }: { change: (typeof CHANGES)[number]; item: Item }): ReactElement {
  const label = itemLabel(item);
  return (
    <li
      data-change={change}
      data-item={label}
      className="flex items-baseline gap-x-[18px] border-b border-border/40 px-[18px] py-[10px]"
    >
      <span className={`${MONO} w-[72px] shrink-0 uppercase text-text-secondary`}>
        {MARKS[change]} {change}
      </span>
      <span className={`${MONO} min-w-0 break-all text-text-primary`}>{label}</span>
    </li>
  );
}
