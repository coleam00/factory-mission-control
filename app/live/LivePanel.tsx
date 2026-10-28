import type { LiveQueryState, SealedLiveQuery } from '@neon/realtime/client';
import { RealtimeProvider, useLiveQuery } from '@neon/realtime-react';
import { type ReactElement, type ReactNode, useCallback, useEffect, useState } from 'react';
import { followSwitch } from '../lib/rewind';
import { useLive } from './LiveProvider';
import {
  discardObservation,
  expectSubscribe,
  markRendered,
  observeQuery,
  type QueryObservation,
} from './subscribe-marks';

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
 * Read by `bun run test:live`: when the panel asked for its seal, got it, got rows, and renewed. The
 * moment its subscribe is sent is marked by the socket (`subscribe-marks.ts`).
 */
function markOnce(name: string): void {
  if (performance.getEntriesByName(name).length === 0) performance.mark(name);
}

/**
 * Asks the server to seal `query` with the panel's request `body`. A seal for a branch other than
 * `branch`, the one this page's socket is on, means another tab switched: the page reloads onto
 * it, and the returned promise never settles, so the panel asks nothing more.
 */
export async function seal<Row>(
  query: string,
  body: string,
  branch: string | null,
): Promise<SealedLiveQuery<Row>> {
  const res = await fetch(`/api/live/${query}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
  if (!res.ok) throw new Error(`sealing ${query} answered ${res.status}`);
  const { rewind, ...sealed } = (await res.json()) as SealedLiveQuery<Row> & {
    rewind: string | null;
  };
  if (rewind !== branch) {
    followSwitch();
    return new Promise<never>(() => {});
  }
  return sealed;
}

/** `@neon/realtime` asks for the next seal this long before the current one expires. */
const RENEW_EARLY_MS = 10_000;
/** The wait before retrying a seal that failed or came back expired; it doubles to the ceiling. */
export const SEAL_RETRY_FIRST_MS = 1_000;
export const SEAL_RETRY_CEILING_MS = 16_000;

/**
 * Where one seal's requests stand: the wait the next one owes, counted from when the last was
 * answered, and the request in turn, so only one is ever in flight.
 */
export interface SealBackoff {
  delay: number;
  answeredAt: number;
  turn: Promise<unknown>;
}

export function newSealBackoff(): SealBackoff {
  return { delay: 0, answeredAt: 0, turn: Promise.resolve() };
}

/**
 * Every panel's backoff, by what it seals. Kept outside the component so that whatever asks for
 * the same seal again (the panel's effect re-running, the panel remounting, the library's own
 * retry timer or a reschedule of it) owes the same wait, and the wait keeps growing.
 */
const sealBackoffs = new Map<string, SealBackoff>();

export function sealBackoff(key: string): SealBackoff {
  let backoff = sealBackoffs.get(key);
  if (!backoff) {
    backoff = newSealBackoff();
    sealBackoffs.set(key, backoff);
  }
  return backoff;
}

/**
 * Wraps `request` so a seal that fails, or comes back expired, is asked for again only once a
 * wait, doubling from `SEAL_RETRY_FIRST_MS` to `SEAL_RETRY_CEILING_MS`, has passed since the last
 * answer: never back to back, and never two at once, however often or by whom it is called.
 * An expired seal is thrown, not returned: the library would renew it at once, again and again.
 * A seal too close to expiry for the library to wait before renewing it is returned but backs off
 * too. A seal with a full lifetime resets the wait. Once `signal` aborts, no request is sent.
 */
export function backOffSeals<Row>(
  request: () => Promise<SealedLiveQuery<Row>>,
  signal: AbortSignal,
  {
    backoff = newSealBackoff(),
    now = Date.now,
    wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  }: {
    backoff?: SealBackoff;
    now?: () => number;
    wait?: (ms: number) => Promise<void>;
  } = {},
): () => Promise<SealedLiveQuery<Row>> {
  const answered = (fresh: boolean) => {
    backoff.answeredAt = now();
    backoff.delay = fresh
      ? 0
      : Math.min(SEAL_RETRY_CEILING_MS, Math.max(SEAL_RETRY_FIRST_MS, backoff.delay * 2));
  };
  const stopped = () => new Error('the panel stopped asking for seals');
  const ask = async (): Promise<SealedLiveQuery<Row>> => {
    if (signal.aborted) throw stopped();
    const owed = backoff.answeredAt + backoff.delay - now();
    if (backoff.delay > 0 && owed > 0) await wait(owed);
    if (signal.aborted) throw stopped();
    let sealed: SealedLiveQuery<Row>;
    try {
      sealed = await request();
    } catch (error) {
      answered(false);
      throw error;
    }
    const left = sealed.expiresAt - now();
    answered(left > RENEW_EARLY_MS);
    if (left <= 0) throw new Error(`the seal answered had expired ${-left} ms before`);
    return sealed;
  };
  return () => {
    const turn = backoff.turn.then(ask);
    backoff.turn = turn.catch(() => {});
    return turn;
  };
}

type Render<Row> = (rows: readonly Row[] | undefined, state: PanelState) => ReactNode;

interface LivePanelProps<Row> {
  /** A file name in `db/queries/`, without `.sql`. */
  query: string;
  factory: string | undefined;
  /**
   * Reads the branch the server was started on even while its sealing is switched to a rewind
   * branch: for the rewind list, which must always show the way back.
   */
  home?: boolean;
  /** The query's parameters after the factory (`$2` on), when it takes any. */
  args?: readonly string[];
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
  home = false,
  args,
  className,
  children,
}: LivePanelProps<Row>): ReactElement {
  const live = useLive();
  const [accepted, setAccepted] = useState<{
    /** What the seal was asked for: rows sealed for anything else are not this panel's. */
    asked: string;
    sealed: SealedLiveQuery<Row>;
    observation: QueryObservation;
    requestSeal: () => Promise<SealedLiveQuery<Row>>;
  }>();
  const [failed, setFailed] = useState(false);

  const body = JSON.stringify({ factory, ...(home && { branch: 'home' }), ...(args && { args }) });
  const ready = live.status === 'ready' && factory !== undefined;
  const branch = live.status === 'ready' && !home ? live.rewind : null;
  const asked = `${query} ${body} ${branch}`;
  useEffect(() => {
    if (!ready || factory === undefined) return;
    let cancelled = false;
    let observation: QueryObservation | undefined;
    const stopped = new AbortController();
    const requestSeal = backOffSeals(() => seal<Row>(query, body, branch), stopped.signal, {
      backoff: sealBackoff(asked),
    });
    markOnce(`live:${query}:requested`);
    const ask = (): void => {
      requestSeal().then(
        (first) => {
          if (cancelled) return;
          markOnce(`live:${query}:sealed`);
          const parameters: { args?: string[] } = JSON.parse(body);
          observation = observeQuery({
            query,
            factory,
            args: parameters.args ?? [],
            home,
            branch,
            queryFingerprint: first.queryFingerprint,
          });
          expectSubscribe(first.capability, observation);
          setFailed(false);
          setAccepted({ asked, sealed: first, observation, requestSeal });
        },
        () => {
          if (cancelled) return;
          setFailed(true);
          ask();
        },
      );
    };
    ask();
    return () => {
      cancelled = true;
      stopped.abort();
      if (observation) discardObservation(observation);
    };
  }, [ready, query, factory, body, home, branch, asked]);

  if (live.status !== 'ready' || accepted?.asked !== asked || failed) {
    const state = live.status === 'error' || failed ? 'error' : 'loading';
    return (
      <Frame query={query} state={state} className={className}>
        {children(undefined, state)}
      </Frame>
    );
  }
  return (
    <RealtimeProvider client={accepted.observation.home ? live.homeClient : live.client}>
      <Subscribed
        query={accepted.observation.query}
        sealed={accepted.sealed}
        observation={accepted.observation}
        requestSeal={accepted.requestSeal}
        className={className}
        render={children}
      />
    </RealtimeProvider>
  );
}

function Subscribed<Row>({
  query,
  sealed,
  observation,
  requestSeal,
  className,
  render,
}: {
  query: string;
  sealed: SealedLiveQuery<Row>;
  observation: QueryObservation;
  requestSeal: () => Promise<SealedLiveQuery<Row>>;
  className?: string;
  render: Render<Row>;
}): ReactElement {
  const refreshQuery = useCallback(async () => {
    const renewed = await requestSeal();
    expectSubscribe(renewed.capability, observation);
    performance.mark(`live:${query}:renewed`);
    return renewed;
  }, [query, requestSeal, observation]);
  const { status, data, error } = useLiveQuery(sealed, { refreshQuery });
  const [wasRecovering, setRecovering] = useState(false);
  const isRecovering = recovering(wasRecovering, status);
  if (isRecovering !== wasRecovering) setRecovering(isRecovering);
  const state = panelState({ status, data, error, recovering: isRecovering });

  useEffect(() => {
    if (state === 'ready') markRendered(observation);
  }, [state, observation]);

  return (
    <Frame query={query} state={state} className={className}>
      {render(state === 'loading' ? undefined : data, state)}
    </Frame>
  );
}
