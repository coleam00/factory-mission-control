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
import { discardEarlySocket, earlySocketFactory } from './early-socket';
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

/** The wait before replacing a client whose connection ended; it doubles to the ceiling. */
export const REPLACE_FIRST_MS = 1_000;
export const REPLACE_CEILING_MS = 16_000;

type Clients = { client: RealtimeClient; homeClient: RealtimeClient };

/** A client on `url` that calls `ended` once its connection has ended for good. */
function connect(url: string, transport: WebSocketFactory, ended: () => void): RealtimeClient {
  return createRealtimeClient({
    url,
    webSocketFactory: markingSubscribes(transport),
    logLevel: 'error',
    logger: (entry) => {
      if (!CONNECTION_ENDED.has(entry.event)) return;
      console.warn(`Realtime connection ended for good (${entry.event}); opening a new one`);
      ended();
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
 * `REPLACE_FIRST_MS` to `REPLACE_CEILING_MS` for as long as the page is open, and the panels
 * subscribe on the new one. The ended client has already closed its socket; it is dropped, not
 * closed, so its panels never read `closed` before they move.
 */
export function LiveProvider({ children }: { children: ReactNode }): ReactElement {
  const [live, setLive] = useState<Live>({ status: 'loading' });

  useEffect(() => {
    let config: LiveConfig | undefined;
    let clients: Clients | undefined;
    let cancelled = false;
    let wait = 0;
    let replacing: ReturnType<typeof setTimeout> | undefined;
    const publish = () => {
      if (cancelled || !config || !clients) return;
      setLive({ status: 'ready', factories: config.factories, rewind: config.rewind, ...clients });
    };
    const ended = new Set<RealtimeClient>();
    const replaceEnded = () => {
      if (!config || !clients) return;
      const { client, homeClient } = clients;
      const shared = client === homeClient;
      let nextClient = client;
      let nextHome = homeClient;
      if (ended.has(client)) {
        const next = connect(config.url, newSocket, () => onEnded(next));
        nextClient = next;
        if (shared) nextHome = next;
      }
      if (!shared && ended.has(homeClient)) {
        const next = connect(config.home, newSocket, () => onEnded(next));
        nextHome = next;
      }
      ended.clear();
      clients = { client: nextClient, homeClient: nextHome };
      publish();
    };
    const onEnded = (client: RealtimeClient) => {
      if (cancelled) return;
      ended.add(client);
      if (replacing !== undefined) return;
      wait = Math.min(REPLACE_CEILING_MS, Math.max(REPLACE_FIRST_MS, wait * 2));
      replacing = setTimeout(() => {
        replacing = undefined;
        if (!cancelled) replaceEnded();
      }, wait);
    };
    /** The clients for `config`; a second one for the home branch only while rewound. */
    const clientsFor = (transport: WebSocketFactory): Clients => {
      const at = config as LiveConfig;
      const client = connect(at.url, transport, () => onEnded(client));
      const homeClient =
        at.rewind === null ? client : connect(at.home, newSocket, () => onEnded(homeClient));
      return { client, homeClient };
    };
    const close = () => {
      cancelled = true;
      clearTimeout(replacing);
      clients?.client.close();
      if (clients?.homeClient !== clients?.client) clients?.homeClient.close();
    };
    const boot = window.__MC_LIVE__;
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
  }, []);

  return <LiveContext.Provider value={live}>{children}</LiveContext.Provider>;
}

export function useLive(): Live {
  return useContext(LiveContext);
}
