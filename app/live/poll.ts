import { useEffect, useState } from 'react';

/**
 * Local mode (server/local-live.ts): no Realtime. A panel's "seal" carries the query name and its
 * parameters, and the page polls `POST /api/live-rows` with them. `usePolledQuery` answers the
 * same `{ status, data, error }` as `useLiveQuery`, so `panelState` reads both alike.
 */
export interface LocalSealed {
  local: { query: string; params: string[] };
}

export const POLL_INTERVAL_MS = 3_000;
/** A poll not answered by then has failed; the next one is a full interval later. */
export const POLL_TIMEOUT_MS = 10_000;

export type PolledState<Row> =
  | { status: 'connecting' | 'live'; data: Row[] | undefined; error: undefined }
  | { status: 'error'; data: Row[] | undefined; error: unknown };

interface RowsAnswer {
  rows: Record<string, unknown>[];
  timestamps?: string[];
  dates?: string[];
}

/** Turns the server's timestamp (ISO) and date (`YYYY-MM-DD`) columns into `Date`s, as Realtime does. */
export function reviveRows<Row>(answer: RowsAnswer): Row[] {
  const timestamps = answer.timestamps ?? [];
  const dates = answer.dates ?? [];
  if (timestamps.length === 0 && dates.length === 0) return answer.rows as Row[];
  return answer.rows.map((row) => {
    const out: Record<string, unknown> = { ...row };
    for (const name of timestamps) {
      if (typeof out[name] === 'string') out[name] = new Date(out[name] as string);
    }
    for (const name of dates) {
      const m =
        typeof out[name] === 'string' && /^(\d{4})-(\d{2})-(\d{2})$/.exec(out[name] as string);
      if (m) out[name] = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    }
    return out as Row;
  });
}

export type FetchRows = (sealed: LocalSealed) => Promise<RowsAnswer>;

export const fetchRows: FetchRows = async (sealed) => {
  const res = await fetch('/api/live-rows', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(sealed.local),
    signal: AbortSignal.timeout(POLL_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`polling ${sealed.local.query} answered ${res.status}`);
  return (await res.json()) as RowsAnswer;
};

export interface PollDeps {
  fetchRows: FetchRows;
  intervalMs: number;
  isHidden: () => boolean;
  /** Calls `listener` whenever visibility changes; returns the unsubscribe. */
  onVisibility: (listener: () => void) => () => void;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (timer: unknown) => void;
}

function browserDeps(): PollDeps {
  return {
    fetchRows,
    intervalMs: POLL_INTERVAL_MS,
    isHidden: () => typeof document !== 'undefined' && document.visibilityState === 'hidden',
    onVisibility: (listener) => {
      if (typeof document === 'undefined') return () => {};
      document.addEventListener('visibilitychange', listener);
      return () => document.removeEventListener('visibilitychange', listener);
    },
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
  };
}

/**
 * Polls at once, then `intervalMs` after each answer, never two at a time. While hidden no poll is
 * scheduled; becoming visible polls at once. Rows kept through an error stay in `data`. Returns
 * the stop.
 */
export function startPolling<Row>(
  sealed: LocalSealed,
  publish: (state: PolledState<Row>) => void,
  deps: PollDeps,
): () => void {
  let stopped = false;
  let inFlight = false;
  let timer: unknown;
  let data: Row[] | undefined;
  const schedule = () => {
    if (stopped || deps.isHidden()) return;
    timer = deps.setTimer(poll, deps.intervalMs);
  };
  const poll = () => {
    timer = undefined;
    if (stopped || inFlight) return;
    inFlight = true;
    deps.fetchRows(sealed).then(
      (answer) => {
        inFlight = false;
        if (stopped) return;
        data = reviveRows<Row>(answer);
        publish({ status: 'live', data, error: undefined });
        schedule();
      },
      (error: unknown) => {
        inFlight = false;
        if (stopped) return;
        publish({ status: 'error', data, error });
        schedule();
      },
    );
  };
  const unlisten = deps.onVisibility(() => {
    if (stopped) return;
    if (deps.isHidden()) {
      if (timer !== undefined) deps.clearTimer(timer);
      timer = undefined;
    } else if (timer === undefined) {
      poll();
    }
  });
  if (!deps.isHidden()) poll();
  return () => {
    stopped = true;
    if (timer !== undefined) deps.clearTimer(timer);
    unlisten();
  };
}

/** `useLiveQuery`'s contract over polling. `deps` is for tests. */
export function usePolledQuery<Row>(
  sealed: LocalSealed,
  deps?: Partial<PollDeps>,
): PolledState<Row> {
  const [state, setState] = useState<PolledState<Row>>({
    status: 'connecting',
    data: undefined,
    error: undefined,
  });
  const key = JSON.stringify(sealed.local);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for `sealed`; `deps` is fixed per mount
  useEffect(() => {
    setState({ status: 'connecting', data: undefined, error: undefined });
    return startPolling<Row>(sealed, setState, { ...browserDeps(), ...deps });
  }, [key]);
  return state;
}
