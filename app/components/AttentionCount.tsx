import { type ReactElement, useCallback, useState } from 'react';
import { ATTENTION_SOURCES, attentionCount, badgePanelName } from '../lib/attention-page';
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

type SourceKey = keyof typeof ATTENTION_SOURCES;

/** One source's feed, with a callback that stays the same across renders so its report runs only on change. */
function CountFeed({
  id,
  factory,
  report,
}: {
  id: SourceKey;
  factory: string;
  report: (id: SourceKey, source: Source<object>) => void;
}): ReactElement {
  const { query } = ATTENTION_SOURCES[id];
  const into = useCallback((source: Source<object>) => report(id, source), [id, report]);
  return <Feed<object> query={query} name={badgePanelName(query)} factory={factory} into={into} />;
}

/**
 * The Attention tab's violet count: the rows of the live queries the page itself reads
 * (`ATTENTION_SOURCES`), counted by `attentionCount`, so the count is the page's cards by construction.
 */
export function AttentionCount({ factory }: { factory: string }): ReactElement {
  const [sources, setSources] = useState<Record<SourceKey, Source<object>>>({
    decide: AWAITED,
    owner: AWAITED,
    unstick: AWAITED,
    failures: AWAITED,
  });
  const report = useCallback(
    (id: SourceKey, source: Source<object>) => setSources((all) => ({ ...all, [id]: source })),
    [],
  );
  return (
    <>
      {(Object.keys(ATTENTION_SOURCES) as SourceKey[]).map((id) => (
        <CountFeed key={id} id={id} factory={factory} report={report} />
      ))}
      <CountMark sources={Object.values(sources)} />
    </>
  );
}
