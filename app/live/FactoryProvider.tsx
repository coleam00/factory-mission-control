import {
  createContext,
  type ReactElement,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { useParams } from 'react-router';
import {
  currentFactory,
  type Listed,
  readRemembered,
  remember,
  toRemember,
} from '../lib/factory-choice';
import { useLive } from './LiveProvider';

interface FactoryChoice {
  current: string | undefined;
  publish: (listed: Listed) => void;
}

const FactoryContext = createContext<FactoryChoice>({ current: undefined, publish: () => {} });

/** Reading `localStorage` itself throws where the browser blocks storage. */
function browserStorage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

const sameListed = (a: Listed, b: Listed): boolean =>
  a.status === b.status &&
  (a.status !== 'ready' ||
    b.status !== 'ready' ||
    (a.names.length === b.names.length && a.names.every((name, i) => name === b.names[i])));

/**
 * Decides the factory every panel shows (`currentFactory`) and remembers, per browser, each listed
 * factory the URL names. The factory switcher publishes the live list it shows.
 */
export function FactoryProvider({ children }: { children: ReactNode }): ReactElement {
  const live = useLive();
  const inUrl = useParams().factory;
  const [listed, setListed] = useState<Listed>({ status: 'loading' });
  const [remembered, setRemembered] = useState(() => readRemembered(browserStorage()));
  const chosen = toRemember(inUrl, listed);

  useEffect(() => {
    if (chosen === undefined || chosen === remembered) return;
    remember(browserStorage(), chosen);
    setRemembered(chosen);
  }, [chosen, remembered]);

  // Counts change the switcher's rows often; only a change of the names reaches the app.
  const publish = useCallback(
    (next: Listed) => setListed((prev) => (sameListed(prev, next) ? prev : next)),
    [],
  );
  const fallback = live.status === 'ready' ? live.factories[0] : undefined;
  const current = currentFactory({ inUrl, remembered, fallback, listed });
  const value = useMemo(() => ({ current, publish }), [current, publish]);
  return <FactoryContext.Provider value={value}>{children}</FactoryContext.Provider>;
}

/** The factory every panel shows: the URL's, else the remembered one, else factories.json's first. */
export function useFactory(): string | undefined {
  return useContext(FactoryContext).current;
}

/** How the switcher hands the provider the factories it lists. */
export function usePublishFactories(): (listed: Listed) => void {
  return useContext(FactoryContext).publish;
}
