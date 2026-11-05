import type { ReactElement } from 'react';
import { LivePanel } from '../live/LivePanel';
import { type Source, sourceOf } from './Decisions';

const MARK = 'ml-1.5 rounded-full px-1.5 font-mono text-[11px] tabular-nums';
const VIOLET = { color: 'var(--role-person)', backgroundColor: 'var(--role-person-soft)' };

/**
 * The count, or a violet "?" when either query is unavailable: rows kept through an outage are
 * from before it, so they are never counted as current. While a query is loading (including the
 * window where a reconnecting subscription withholds its kept rows) and unavailable is not in
 * play, nothing shows, as at zero.
 */
export function CountMark({
  attention,
  owner,
}: {
  attention: Source<object>;
  owner: Source<object>;
}): ReactElement | null {
  if (attention === 'unavailable' || owner === 'unavailable') {
    return (
      <span
        data-decisions-count="unavailable"
        role="img"
        aria-label="Waiting count unavailable"
        className={MARK}
        style={VIOLET}
      >
        ?
      </span>
    );
  }
  const count =
    attention === 'loading' || owner === 'loading' ? 0 : attention.length + owner.length;
  return count === 0 ? null : (
    <span
      data-decisions-count={count}
      role="img"
      aria-label={`${count} waiting`}
      className={MARK}
      style={VIOLET}
    >
      {count}
    </span>
  );
}

/**
 * The Decisions tab's violet count of open items: the rows of the two live queries the screen
 * itself reads (attention-items and owner-queue), so the count is the screen's items by
 * construction.
 */
export function DecisionsCount({ factory }: { factory: string }): ReactElement {
  return (
    <LivePanel<object>
      query="attention-items"
      name="decisions-count:attention-items"
      factory={factory}
      className="inline"
    >
      {(attention, attentionState) => (
        <LivePanel<object>
          query="owner-queue"
          name="decisions-count:owner-queue"
          factory={factory}
          className="inline"
        >
          {(owner, ownerState) => (
            <CountMark
              attention={sourceOf(attention, attentionState)}
              owner={sourceOf(owner, ownerState)}
            />
          )}
        </LivePanel>
      )}
    </LivePanel>
  );
}
