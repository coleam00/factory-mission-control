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
    signal: AbortSignal.timeout(SEAL_TIMEOUT_MS),
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

/** A seal request not answered by then has failed: the tab's other seals wait behind it. */
export const SEAL_TIMEOUT_MS = 10_000;
/** The wait before retrying a seal that failed or came back expired; it doubles to the ceiling. */
export const SEAL_RETRY_FIRST_MS = 1_000;
export const SEAL_RETRY_CEILING_MS = 16_000;
/** How long a panel must stay live for its seal backoff to reset: past the longest wait. */
export const LIVE_STABLE_MS = SEAL_RETRY_CEILING_MS;
/** The library renews a seal this long before it expires; one with less left than this is renewed at once. */
const RENEW_EARLY_MS = 10_000;

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
 * The tab's sealing as a whole. A panel's first seal is asked for at once, beside every other
 * panel's. Renewals, which start well before a seal expires, are asked for one at a time in the
 * tab (each answers within `SEAL_TIMEOUT_MS`), so the panels renewing together when sealing fails
 * do not all ask at once. Once a seal fails, every request in the tab waits its turn, each the
 * tab's doubling wait after its last failed answer, so a page of many panels asks no more often
 * than one would. The first seal answered again ends the wait.
 */
export const tabSealing: SealBackoff = newSealBackoff();

/**
 * The panel has stayed live on what it was sealed for `LIVE_STABLE_MS`: the next seal it asks for
 * owes no wait. Only this resets the wait. A seal answered with a full lifetime is not enough: the
 * subscription it was for can still refuse it (a connection that failed for good rejects every
 * renewal at once), and the library asks again a second later. Nor is going live: a subscription
 * that is live for a moment and then fails for good, again and again, would reset the wait each
 * time and ask about once a second for good.
 */
export function resetSealBackoff(backoff: SealBackoff): void {
  backoff.delay = 0;
}

/**
 * The subscription the panel was sealed for failed for good: that counts as a failed answer, so
 * the seal it asks for to subscribe again waits, and a subscription that keeps failing as soon as
 * it is live is asked for again no more than once a `SEAL_RETRY_FIRST_MS`.
 */
export function failSealBackoff(backoff: SealBackoff, now = Date.now()): void {
  backoff.answeredAt = now;
  backoff.delay = Math.min(SEAL_RETRY_CEILING_MS, Math.max(SEAL_RETRY_FIRST_MS, backoff.delay * 2));
}

/**
 * Wraps `request` so that once a seal fails, or is answered with too little life left to wait for
 * its renewal, every seal after it is asked for only once a wait, doubling from
 * `SEAL_RETRY_FIRST_MS` to `SEAL_RETRY_CEILING_MS`, has passed since the last answer, until the
 * panel is live again (`resetSealBackoff`). A panel's first seal owes no wait, so a panel that
 * mounts again asks at once while sealing is healthy. Never back to back, and never two at once, however
 * often or by whom it is called. A live panel's renewals come a seal's lifetime apart, far more
 * than the ceiling, so they never wait. A renewal (`renewal` true), and every request while the
 * `tab`'s sealing is failing, also waits its turn in the tab (`tabSealing`). An expired seal is
 * thrown, not returned: the library would renew it at once, again and again. Once `signal`
 * aborts, no request is sent.
 */
export function backOffSeals<Row>(
  request: () => Promise<SealedLiveQuery<Row>>,
  signal: AbortSignal,
  {
    backoff = newSealBackoff(),
    tab = newSealBackoff(),
    now = Date.now,
    wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  }: {
    backoff?: SealBackoff;
    tab?: SealBackoff;
    now?: () => number;
    wait?: (ms: number) => Promise<void>;
  } = {},
): (renewal?: boolean) => Promise<SealedLiveQuery<Row>> {
  const grow = (on: SealBackoff) => failSealBackoff(on, now());
  /** Waits out what `on` owes, or until the panel stops asking. */
  const owe = async (on: SealBackoff) => {
    const owed = on.answeredAt + on.delay - now();
    if (on.delay > 0 && owed > 0 && !signal.aborted) {
      await Promise.race([
        wait(owed),
        new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true }),
        ),
      ]);
    }
  };
  const stopped = () => new Error('the panel stopped asking for seals');
  const send = async (): Promise<SealedLiveQuery<Row>> => {
    if (signal.aborted) throw stopped();
    let sealed: SealedLiveQuery<Row>;
    try {
      sealed = await request();
    } catch (error) {
      grow(backoff);
      grow(tab);
      throw error;
    }
    const left = sealed.expiresAt - now();
    if (backoff.delay > 0 || left <= RENEW_EARLY_MS) grow(backoff);
    if (left <= 0) {
      grow(tab);
      throw new Error(`the seal answered had expired ${-left} ms before`);
    }
    tab.delay = 0;
    return sealed;
  };
  /** One request at a time in the tab, each once the tab's wait has passed. */
  const inTurn = (): Promise<SealedLiveQuery<Row>> => {
    const turn = tab.turn.then(async () => {
      await owe(tab);
      return send();
    });
    tab.turn = turn.catch(() => {});
    return turn;
  };
  const ask = async (renewal: boolean): Promise<SealedLiveQuery<Row>> => {
    if (signal.aborted) throw stopped();
    await owe(backoff);
    return renewal || tab.delay > 0 ? inTurn() : send();
  };
  return (renewal = false) => {
    const turn = backoff.turn.then(() => ask(renewal));
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
    requestSeal: (renewal?: boolean) => Promise<SealedLiveQuery<Row>>;
    backoff: SealBackoff;
  }>();
  const [failed, setFailed] = useState(false);
  // Counts the subscriptions that failed for good: each asks for a new seal and subscribes anew.
  const [lost, setLost] = useState(0);
  const resubscribe = useCallback(() => setLost((n) => n + 1), []);

  const body = JSON.stringify({ factory, ...(home && { branch: 'home' }), ...(args && { args }) });
  const ready = live.status === 'ready' && factory !== undefined;
  const branch = live.status === 'ready' && !home ? live.rewind : null;
  const asked = `${query} ${body} ${branch}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `lost` only re-runs it, so a subscription that failed for good is replaced, not renewed
  useEffect(() => {
    if (!ready || factory === undefined) return;
    let cancelled = false;
    let observation: QueryObservation | undefined;
    const stopped = new AbortController();
    const backoff = sealBackoff(asked);
    const requestSeal = backOffSeals(() => seal<Row>(query, body, branch), stopped.signal, {
      backoff,
      tab: tabSealing,
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
          setAccepted({ asked, sealed: first, observation, requestSeal, backoff });
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
  }, [ready, query, factory, body, home, branch, asked, lost]);

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
        backoff={accepted.backoff}
        onFailed={resubscribe}
        className={className}
        render={children}
      />
    </RealtimeProvider>
  );
}

/**
 * A subscription that reports `error` has failed for good: `@neon/realtime` rejects every renewal
 * of it, so the panel asks for a new seal and subscribes again (`onFailed`), a wait later
 * (`failSealBackoff`), showing `error` until then. Staying `live` (`LIVE_STABLE_MS`) resets the wait.
 */
function Subscribed<Row>({
  query,
  sealed,
  observation,
  requestSeal,
  backoff,
  onFailed,
  className,
  render,
}: {
  query: string;
  sealed: SealedLiveQuery<Row>;
  observation: QueryObservation;
  requestSeal: (renewal?: boolean) => Promise<SealedLiveQuery<Row>>;
  backoff: SealBackoff;
  onFailed: () => void;
  className?: string;
  render: Render<Row>;
}): ReactElement {
  const refreshQuery = useCallback(async () => {
    const renewed = await requestSeal(true);
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

  useEffect(() => {
    if (status === 'live') {
      const stable = setTimeout(() => resetSealBackoff(backoff), LIVE_STABLE_MS);
      return () => clearTimeout(stable);
    }
    if (status === 'error') {
      failSealBackoff(backoff);
      onFailed();
    }
  }, [status, backoff, onFailed]);

  return (
    <Frame query={query} state={state} className={className}>
      {render(state === 'loading' ? undefined : data, state)}
    </Frame>
  );
}
