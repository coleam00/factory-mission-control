import { type ReactElement, useState } from 'react';
import { attentionCount } from '../lib/attention-page';
import { stateColor } from '../lib/states';
import { AWAITED, Feed, type Source } from '../live/Feed';

const MARK = 'ml-1.5 rounded-full px-1.5 font-mono font-medium text-[11px] tabular-nums';
/** The mockup's `.nav .badge`: a solid violet chip with dark text. */
const VIOLET = { color: 'var(--v3-bg)', backgroundColor: stateColor('needs-you') };

/**
 * The count, or a violet "?" when any query is unavailable: rows kept through an outage are from
 * before it, so they are never counted as current. While a query is loading nothing shows, as at zero.
 */
export function CountMark({
  sources,
}: {
  sources: readonly Source<object>[];
}): ReactElement | null {
  const count = attentionCount(sources);
  if (count === 'unavailable') {
    return (
      <span
        data-attention-count="unavailable"
        role="img"
        aria-label="Waiting count unavailable"
        className={MARK}
        style={VIOLET}
      >
        ?
      </span>
    );
  }
  return count === 'loading' || count === 0 ? null : (
    <span
      data-attention-count={count}
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
 * The Attention tab's violet count: the rows of the four live queries the page itself reads, counted
 * by `attentionCount`, so the count is the page's cards by construction.
 */
export function AttentionCount({ factory }: { factory: string }): ReactElement {
  const [decide, setDecide] = useState<Source<object>>(AWAITED);
  const [owner, setOwner] = useState<Source<object>>(AWAITED);
  const [unstick, setUnstick] = useState<Source<object>>(AWAITED);
  const [failures, setFailures] = useState<Source<object>>(AWAITED);
  return (
    <>
      <Feed<object>
        query="decide"
        name="attention-count:decide"
        factory={factory}
        into={setDecide}
      />
      <Feed<object>
        query="owner-queue"
        name="attention-count:owner-queue"
        factory={factory}
        into={setOwner}
      />
      <Feed<object>
        query="unstick"
        name="attention-count:unstick"
        factory={factory}
        into={setUnstick}
      />
      <Feed<object>
        query="failure-groups"
        name="attention-count:failure-groups"
        factory={factory}
        into={setFailures}
      />
      <CountMark sources={[decide, owner, unstick, failures]} />
    </>
  );
}
