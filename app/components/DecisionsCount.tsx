import type { ReactElement } from 'react';
import { LivePanel } from '../live/LivePanel';

/**
 * The Decisions tab's violet count of open items: the rows of the two live queries the screen
 * itself reads (attention-items and owner-queue), so the count is the screen's items by
 * construction. Nothing while loading or at zero.
 */
export function DecisionsCount({ factory }: { factory: string }): ReactElement {
  return (
    <LivePanel<object> query="attention-items" factory={factory} className="inline">
      {(attention) => (
        <LivePanel<object> query="owner-queue" factory={factory} className="inline">
          {(owner) => {
            const count =
              attention === undefined || owner === undefined ? 0 : attention.length + owner.length;
            return count === 0 ? null : (
              <span
                data-decisions-count={count}
                role="img"
                aria-label={`${count} waiting`}
                className="ml-1.5 rounded-full px-1.5 font-mono text-[11px] tabular-nums"
                style={{ color: 'var(--role-person)', backgroundColor: 'var(--role-person-soft)' }}
              >
                {count}
              </span>
            );
          }}
        </LivePanel>
      )}
    </LivePanel>
  );
}
