import type { LiveQueryState, SealedLiveQuery } from '@neon/realtime/client';
import { RealtimeProvider, useLiveQuery } from '@neon/realtime-react';
import { type ReactElement, type ReactNode, useCallback, useEffect, useState } from 'react';
import { useLive } from './LiveProvider';
import { expectSubscribe } from './subscribe-marks';

export type PanelState = 'loading' | 'ready' | 'error';

/**
 * Rows kept while a renewal reconnects are still the query's rows, so a panel stays `ready`
 * through `connecting`. A `stale` subscription's seal has expired with no replacement: it gets
 * no more updates, so its rows are no longer live and the panel is in `error`. Rows kept through
 * a `stale` or `error` spell are from before the outage, so while the subscription reconnects
 * after one (`recovering`) the panel is `loading`, not `ready`, until it is `live` again.
 */
export function panelState({
  status,
  data,
  error,
  recovering = false,
}: {
  status: LiveQueryState['status'];
  data: readonly unknown[] | undefined;
  error: unknown;
  recovering?: boolean;
}): PanelState {
  if (error !== undefined || status === 'error' || status === 'stale') return 'error';
  if (recovering && status !== 'live') return 'loading';
  return data === undefined ? 'loading' : 'ready';
}

/**
 * Whether a subscription is in or coming back from an outage: it entered one at `stale` or
 * `error`, and it leaves it only at `live`, when the fresh snapshot has been published.
 */
export function recovering(wasRecovering: boolean, status: LiveQueryState['status']): boolean {
  if (status === 'stale' || status === 'error') return true;
  if (status === 'live') return false;
  return wasRecovering;
}

/**
 * Read by `bun run test:live`: when the panel asked for its seal, got rows, and renewed. The
 * moment its subscribe is sent is marked by the socket (`subscribe-marks.ts`).
 */
function markOnce(name: string): void {
  if (performance.getEntriesByName(name).length === 0) performance.mark(name);
}

type Render<Row> = (rows: readonly Row[] | undefined, state: PanelState) => ReactNode;

interface LivePanelProps<Row> {
  /** A file name in `db/queries/`, without `.sql`. */
  query: string;
  factory: string | undefined;
  className?: string;
  children: Render<Row>;
}

function Frame({
  query,
  state,
  className,
  children,
}: {
  query: string;
  state: PanelState;
  className?: string;
  children: ReactNode;
}): ReactElement {
  return (
    <section data-live={query} data-state={state} className={className}>
      {children}
    </section>
  );
}

/**
 * The one way a panel goes live: seals `query` for `factory` on the server, subscribes, renews
 * the seal before it expires, and sets `data-state` on the panel. No panel calls
 * `useLiveQuery` directly.
 */
export function LivePanel<Row>({
  query,
  factory,
  className,
  children,
}: LivePanelProps<Row>): ReactElement {
  const live = useLive();
  const [sealed, setSealed] = useState<SealedLiveQuery<Row>>();
  const [failed, setFailed] = useState(false);

  const requestSeal = useCallback(async (): Promise<SealedLiveQuery<Row>> => {
    const res = await fetch(`/api/live/${query}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ factory }),
    });
    if (!res.ok) throw new Error(`sealing ${query} answered ${res.status}`);
    return (await res.json()) as SealedLiveQuery<Row>;
  }, [query, factory]);

  const ready = live.status === 'ready' && factory !== undefined;
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    markOnce(`live:${query}:requested`);
    requestSeal().then(
      (first) => {
        if (cancelled) return;
        expectSubscribe(first.capability, query);
        setSealed(first);
      },
      () => !cancelled && setFailed(true),
    );
    return () => {
      cancelled = true;
    };
  }, [ready, query, requestSeal]);

  if (live.status !== 'ready' || sealed === undefined || failed) {
    const state = live.status === 'error' || failed ? 'error' : 'loading';
    return (
      <Frame query={query} state={state} className={className}>
        {children(undefined, state)}
      </Frame>
    );
  }
  return (
    <RealtimeProvider client={live.client}>
      <Subscribed
        query={query}
        sealed={sealed}
        requestSeal={requestSeal}
        className={className}
        render={children}
      />
    </RealtimeProvider>
  );
}

function Subscribed<Row>({
  query,
  sealed,
  requestSeal,
  className,
  render,
}: {
  query: string;
  sealed: SealedLiveQuery<Row>;
  requestSeal: () => Promise<SealedLiveQuery<Row>>;
  className?: string;
  render: Render<Row>;
}): ReactElement {
  const refreshQuery = useCallback(async () => {
    const renewed = await requestSeal();
    performance.mark(`live:${query}:renewed`);
    return renewed;
  }, [query, requestSeal]);
  const { status, data, error } = useLiveQuery(sealed, { refreshQuery });
  const [wasRecovering, setRecovering] = useState(false);
  const isRecovering = recovering(wasRecovering, status);
  if (isRecovering !== wasRecovering) setRecovering(isRecovering);
  const state = panelState({ status, data, error, recovering: isRecovering });

  useEffect(() => {
    if (state === 'ready') markOnce(`live:${query}:ready`);
  }, [state, query]);

  return (
    <Frame query={query} state={state} className={className}>
      {render(state === 'loading' ? undefined : data, state)}
    </Frame>
  );
}
