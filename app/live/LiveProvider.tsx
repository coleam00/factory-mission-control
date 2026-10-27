import {
  createRealtimeClient,
  type RealtimeClient,
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

/** The clients for `config`; a second one for the home branch only while rewound. */
function clientsFor(
  config: LiveConfig,
  transport: WebSocketFactory,
): { client: RealtimeClient; homeClient: RealtimeClient } {
  const client = createRealtimeClient({
    url: config.url,
    webSocketFactory: markingSubscribes(transport),
  });
  const homeClient =
    config.rewind === null
      ? client
      : createRealtimeClient({ url: config.home, webSocketFactory: markingSubscribes(newSocket) });
  return { client, homeClient };
}

/**
 * Opens the Realtime connection the app shares; panels render `error` when it cannot. When the
 * server put the configuration in the page, the client takes over the socket the page already
 * opened; otherwise it asks `GET /api/live`.
 */
export function LiveProvider({ children }: { children: ReactNode }): ReactElement {
  const [live, setLive] = useState<Live>({ status: 'loading' });

  useEffect(() => {
    let clients: { client: RealtimeClient; homeClient: RealtimeClient } | undefined;
    let cancelled = false;
    const close = () => {
      clients?.client.close();
      if (clients?.homeClient !== clients?.client) clients?.homeClient.close();
    };
    const boot = window.__MC_LIVE__;
    if (boot) {
      clients = clientsFor(boot, earlySocketFactory(boot));
      setLive({ status: 'ready', factories: boot.factories, rewind: boot.rewind, ...clients });
      return () => {
        close();
        discardEarlySocket(boot);
      };
    }
    fetch('/api/live')
      .then(async (res) => {
        if (!res.ok) throw new Error(`GET /api/live answered ${res.status}`);
        const config = (await res.json()) as LiveConfig;
        if (cancelled) return;
        clients = clientsFor(config, newSocket);
        setLive({
          status: 'ready',
          factories: config.factories,
          rewind: config.rewind,
          ...clients,
        });
      })
      .catch(() => {
        if (!cancelled) setLive({ status: 'error' });
      });
    return () => {
      cancelled = true;
      close();
    };
  }, []);

  return <LiveContext.Provider value={live}>{children}</LiveContext.Provider>;
}

export function useLive(): Live {
  return useContext(LiveContext);
}
