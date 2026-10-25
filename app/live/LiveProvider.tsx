import { createRealtimeClient, type RealtimeClient } from '@neon/realtime/client';
import {
  createContext,
  type ReactElement,
  type ReactNode,
  useContext,
  useEffect,
  useState,
} from 'react';

export type Live =
  | { status: 'loading' | 'error' }
  | { status: 'ready'; factories: readonly string[]; client: RealtimeClient };

const LiveContext = createContext<Live>({ status: 'loading' });

/** What `GET /api/live` answers: everything the browser needs to subscribe, and no secret. */
interface LiveConfig {
  url: string;
  factories: string[];
}

/** Opens the one Realtime connection the app shares; panels render `error` when it cannot. */
export function LiveProvider({ children }: { children: ReactNode }): ReactElement {
  const [live, setLive] = useState<Live>({ status: 'loading' });

  useEffect(() => {
    let client: RealtimeClient | undefined;
    let cancelled = false;
    fetch('/api/live')
      .then(async (res) => {
        if (!res.ok) throw new Error(`GET /api/live answered ${res.status}`);
        const config = (await res.json()) as LiveConfig;
        if (cancelled) return;
        client = createRealtimeClient({ url: config.url });
        setLive({ status: 'ready', factories: config.factories, client });
      })
      .catch(() => {
        if (!cancelled) setLive({ status: 'error' });
      });
    return () => {
      cancelled = true;
      client?.close();
    };
  }, []);

  return <LiveContext.Provider value={live}>{children}</LiveContext.Provider>;
}

export function useLive(): Live {
  return useContext(LiveContext);
}

/** The factory every panel shows: until a picker exists, the first in factories.json. */
export function useFactory(): string | undefined {
  const live = useLive();
  return live.status === 'ready' ? live.factories[0] : undefined;
}
