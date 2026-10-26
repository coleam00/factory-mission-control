import { type ReactElement, useState } from 'react';
import { type RewindBranchRow, rewindMoment, switchBranch } from '../lib/rewind';
import { LivePanel } from '../live/LivePanel';
import { EmptyState } from './EmptyState';

const LABEL = 'font-mono text-[10px] font-semibold uppercase tracking-[0.04em] text-text-secondary';
const MONO = 'font-mono text-[12px] tabular-nums';
const ACTION =
  'font-mono text-[11px] font-semibold uppercase tracking-[0.1em] text-accent-bright transition-colors hover:text-text-primary';

/**
 * The rewind branches `bun run rewind:create` made, read from the server's home branch even while
 * rewound, so the way back is always on screen. `shown` is the branch the server seals for.
 */
export function RewindBranches({
  factory,
  shown,
}: {
  factory: string | undefined;
  shown: string | null;
}): ReactElement {
  const [failure, setFailure] = useState<string>();
  const onSwitch = (branch: string | null) => {
    setFailure(undefined);
    switchBranch(branch).catch((error: Error) => setFailure(error.message));
  };
  return (
    <LivePanel<RewindBranchRow> query="rewind-branches" factory={factory} home>
      {(rows, state) => (
        <>
          <h1 className={`${LABEL} mb-3`}>Rewind</h1>
          {state === 'error' ? (
            <p className="text-sm text-text-secondary">Live data is unavailable.</p>
          ) : rows === undefined ? (
            <p className="text-sm text-text-secondary">Loading rewind branches.</p>
          ) : rows.length === 0 ? (
            <EmptyState title="No rewind branches yet: create one with bun run rewind:create <ISO time>." />
          ) : (
            <RewindRows rows={rows} shown={shown} onSwitch={onSwitch} failure={failure} />
          )}
        </>
      )}
    </LivePanel>
  );
}

export function RewindRows({
  rows,
  shown,
  onSwitch,
  failure,
}: {
  rows: readonly RewindBranchRow[];
  shown: string | null;
  onSwitch: (branch: string | null) => void;
  failure?: string;
}): ReactElement {
  return (
    <>
      {shown === null ? null : (
        <div className="mb-4 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
          <p className="text-text-secondary">
            Showing <span className={`${MONO} text-text-primary`}>{shown}</span>, read-only.
          </p>
          <button type="button" data-switch-back onClick={() => onSwitch(null)} className={ACTION}>
            Back to the live branch
          </button>
        </div>
      )}
      <ol className="border-t border-border/40">
        {rows.map((row) => {
          const current = row.name === shown;
          return (
            <li
              key={row.name}
              data-rewind-branch={row.name}
              data-current={current ? '' : undefined}
              className={`flex flex-wrap items-center gap-x-[18px] gap-y-1 border-b border-border/40 px-[18px] py-[13px] ${
                current ? 'bg-surface-hover ring-2 ring-inset ring-accent-bright/40' : ''
              }`}
            >
              <span className={`${MONO} min-w-0 break-all font-bold text-text-primary`}>
                {row.name}
              </span>
              <span className={`${MONO} text-text-secondary`}>as of {rewindMoment(row.at)}</span>
              <span className={`${MONO} text-text-secondary`}>from {row.parent}</span>
              {current ? (
                <span className="ml-auto font-mono text-[11px] font-semibold uppercase tracking-[0.1em] text-warning">
                  Shown
                </span>
              ) : (
                <button
                  type="button"
                  aria-label={`Show ${row.name}`}
                  onClick={() => onSwitch(row.name)}
                  className={`ml-auto ${ACTION}`}
                >
                  Show
                </button>
              )}
            </li>
          );
        })}
      </ol>
      {failure === undefined ? null : (
        <p data-switch-failure className="mt-4 text-sm text-text-secondary">
          Could not switch: {failure}.
        </p>
      )}
    </>
  );
}
