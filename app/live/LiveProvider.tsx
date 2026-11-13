import {
  createRealtimeClient,
  type RealtimeClient,
  type RealtimeLogEvent,
  type WebSocketFactory,
} from '@neon/realtime/client';
import {
  createContext,
  type ReactElement,
  type ReactNode,
  useContext,
  useEffect,
  useState,
} from 'react';
import { discardEarlySocket, earlySocketFactory, type LiveBoot } from './early-socket';
import { markingSubscribes } from './subscribe-marks';

export type Live =
  | { status: 'loading' | 'error' }
  | {
      status: 'ready';
      factories: readonly string[];
      client: RealtimeClient;
      /** The home branch's client: `client` itself unless the server is switched to a rewind. */
      homeClient: RealtimeClient;
      /** The rewind branch the server seals for, or null on its home branch. */
      rewind: string | null;
      /** True once `client`'s connection has stayed down `OFFLINE_AFTER_MS`; false once it connects again. */
      offline: boolean;
      /** The same for `homeClient`. */
      homeOffline: boolean;
    };

/** Exported for tests, which render the shell over a given configuration. */
export const LiveContext = createContext<Live>({ status: 'loading' });

/** What `GET /api/live` answers: everything the browser needs to subscribe, and no secret. */
interface LiveConfig {
  url: string;
  home: string;
  factories: string[];
  rewind: string | null;
}

const newSocket: WebSocketFactory = (url, protocols) => new WebSocket(url, protocols);

/** What `@neon/realtime` reports when a client's connection has ended for good. */
const CONNECTION_ENDED: ReadonlySet<RealtimeLogEvent> = new Set(['connection_failed']);
/** A refused or dropped connection: the client is reconnecting, and `connection_lost` fires once per outage. */
const CONNECTION_DOWN: ReadonlySet<RealtimeLogEvent> = new Set(['connection_lost']);
const CONNECTION_UP: ReadonlySet<RealtimeLogEvent> = new Set([
  'connection_ready',
  'connection_recovered',
]);

/** The wait before replacing a client whose connection ended; it doubles to the ceiling. */
export const REPLACE_FIRST_MS = 1_000;
export const REPLACE_CEILING_MS = 16_000;
/** How long the clients must go without ending for the wait to reset: past the longest wait, as `LIVE_STABLE_MS` is in `LivePanel.tsx`. */
export const REPLACE_STABLE_MS = REPLACE_CEILING_MS;

/**
 * How long a client's connection may stay down, counted from when it was lost, before its panels
 * say they cannot connect: the ceiling of the replacement wait. A reconnect after a healthy
 * stretch retries within a second, so it never reaches this.
 */
export const OFFLINE_AFTER_MS = REPLACE_CEILING_MS;

export type ConnectionEvent = 'ended' | 'down' | 'up';

/** Opens a client on `url` that reports when its connection ended for good, went down, or came up. */
export type Connect = (
  url: string,
  transport: WebSocketFactory,
  report: (event: ConnectionEvent) => void,
) => RealtimeClient;

type Clients = { client: RealtimeClient; homeClient: RealtimeClient };

/** A client on `url` that reports its connection's events to `report`. Exported for tests. */
export function connect(
  url: string,
  transport: WebSocketFactory,
  report: (event: ConnectionEvent) => void,
): RealtimeClient {
  return createRealtimeClient({
    url,
    webSocketFactory: markingSubscribes(transport),
    logLevel: 'info',
    logger: (entry) => {
      if (CONNECTION_DOWN.has(entry.event)) report('down');
      else if (CONNECTION_UP.has(entry.event)) report('up');
      else if (CONNECTION_ENDED.has(entry.event)) {
        console.warn(`Realtime connection ended for good (${entry.event}); opening a new one`);
        report('ended');
      }
    },
  });
}

/**
 * Opens the Realtime connection the app shares; panels render `error` when it cannot. When the
 * server put the configuration in the page, the client takes over the socket the page already
 * opened; otherwise it asks `GET /api/live`.
 *
 * A client whose connection ended for good (a protocol failure; the client is built without reconnect limits, so it never gives up reconnecting)
 * never connects again and rejects every renewal, so the panels on it would stay in `error` until
 * a reload. It is replaced by a new client on the same URL, after a wait that doubles from
 * `REPLACE_FIRST_MS` to `REPLACE_CEILING_MS` while connections keep ending, and the panels
 * subscribe on the new one. The wait resets to `REPLACE_FIRST_MS` once no client has ended for
 * `REPLACE_STABLE_MS` since the last replacement, so the first outage after a healthy stretch is
 * not slow. A client that is reconnecting but has not ended counts as healthy here: its own
 * reconnect backoff paces it, and replacing it would not help. The ended client has already closed its socket; it is dropped, not
 * closed, so its panels never read `closed` before they move.
 *
 * A client whose connection stays down `OFFLINE_AFTER_MS` (every handshake refused, say) is
 * published `offline`, so its panels say they cannot connect while it keeps reconnecting, and it is
 * published online the moment it connects.
 */
export function LiveProvider({ children }: { children: ReactNode }): ReactElement {
  const [live, setLive] = useState<Live>({ status: 'loading' });

  useEffect(() => shareLive(window.__MC_LIVE__, setLive), []);

  return <LiveContext.Provider value={live}>{children}</LiveContext.Provider>;
}

export function useLive(): Live {
  return useContext(LiveContext);
}

export const OFFLINE_SENTENCE = 'Cannot connect to Realtime for live data; still retrying.';
export const UNAVAILABLE_SENTENCE = 'Live data is unavailable.';

/** What a panel in `error` says: that the connection is down when its client is offline, else that its data is unavailable. */
export function useUnavailable(): string {
  const live = useLive();
  return live.status === 'ready' && live.offline ? OFFLINE_SENTENCE : UNAVAILABLE_SENTENCE;
}

/** Opens the clients for `boot` (or `GET /api/live`), publishing each `Live` to `setLive`; returns the cleanup. Exported for tests. */
export function shareLive(
  boot: LiveBoot | undefined,
  setLive: (live: Live) => void,
  open: Connect = connect,
): () => void {
  let config: LiveConfig | undefined;
  let clients: Clients | undefined;
  let cancelled = false;
  let wait = 0;
  let replacedAt = 0;
  let replacing: ReturnType<typeof setTimeout> | undefined;
  const offline = new Set<RealtimeClient>();
  const down = new Map<RealtimeClient, ReturnType<typeof setTimeout>>();
  const publish = () => {
    if (cancelled || !config || !clients) return;
    setLive({
      status: 'ready',
      factories: config.factories,
      rewind: config.rewind,
      offline: offline.has(clients.client),
      homeOffline: offline.has(clients.homeClient),
      ...clients,
    });
  };
  const forget = (client: RealtimeClient) => {
    clearTimeout(down.get(client));
    down.delete(client);
  };
  const ended = new Set<RealtimeClient>();
  const replaceEnded = () => {
    if (!config || !clients) return;
    const { client, homeClient } = clients;
    const shared = client === homeClient;
    let nextClient = client;
    let nextHome = homeClient;
    if (ended.has(client)) {
      const next = open(config.url, newSocket, (event) => onReport(next, event));
      nextClient = next;
      if (shared) nextHome = next;
    }
    if (!shared && ended.has(homeClient)) {
      const next = open(config.home, newSocket, (event) => onReport(next, event));
      nextHome = next;
    }
    for (const gone of ended) {
      forget(gone);
      offline.delete(gone);
    }
    ended.clear();
    replacedAt = Date.now();
    clients = { client: nextClient, homeClient: nextHome };
    publish();
  };
  const onEnded = (client: RealtimeClient) => {
    if (cancelled) return;
    ended.add(client);
    if (replacing !== undefined) return;
    if (Date.now() - replacedAt >= REPLACE_STABLE_MS) wait = 0;
    wait = Math.min(REPLACE_CEILING_MS, Math.max(REPLACE_FIRST_MS, wait * 2));
    replacing = setTimeout(() => {
      replacing = undefined;
      if (!cancelled) replaceEnded();
    }, wait);
  };
  const onReport = (client: RealtimeClient, event: ConnectionEvent) => {
    if (cancelled) return;
    if (event === 'ended') {
      forget(client);
      onEnded(client);
    } else if (event === 'down') {
      if (down.has(client) || offline.has(client)) return;
      down.set(
        client,
        setTimeout(() => {
          down.delete(client);
          offline.add(client);
          publish();
        }, OFFLINE_AFTER_MS),
      );
    } else {
      forget(client);
      if (offline.delete(client)) publish();
    }
  };
  /** The clients for `config`; a second one for the home branch only while rewound. */
  const clientsFor = (transport: WebSocketFactory): Clients => {
    const at = config as LiveConfig;
    const client = open(at.url, transport, (event) => onReport(client, event));
    const homeClient =
      at.rewind === null
        ? client
        : open(at.home, newSocket, (event) => onReport(homeClient, event));
    return { client, homeClient };
  };
  const close = () => {
    cancelled = true;
    clearTimeout(replacing);
    for (const timer of down.values()) clearTimeout(timer);
    clients?.client.close();
    if (clients?.homeClient !== clients?.client) clients?.homeClient.close();
  };
  if (boot) {
    config = boot;
    clients = clientsFor(earlySocketFactory(boot));
    publish();
    return () => {
      close();
      discardEarlySocket(boot);
    };
  }
  fetch('/api/live')
    .then(async (res) => {
      if (!res.ok) throw new Error(`GET /api/live answered ${res.status}`);
      const answered = (await res.json()) as LiveConfig;
      if (cancelled) return;
      config = answered;
      clients = clientsFor(newSocket);
      publish();
    })
    .catch(() => {
      if (!cancelled) setLive({ status: 'error' });
    });
  return close;
}
