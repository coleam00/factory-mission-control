import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { useLocation } from 'react-router';
import type { ManagerAsk } from '../lib/manager';

const OPEN_KEY = 'mc.manager.open';
const OPEN_EVENT = 'mc:manager-open';

/**
 * Under this width there is no side nav and no docked panel: a top bar and a tab bar instead.
 * The nav (216 px) and the dock (384 px) leave a page column too narrow to read below 1024 px.
 */
export const PHONE_QUERY = '(max-width: 1023.98px)';

/** Reading `localStorage` itself throws where the browser blocks storage. */
function storage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

/** Whether the dock was left open: open until the person closes it. */
export function readOpen(store: Pick<Storage, 'getItem'> | undefined): boolean {
  try {
    return store?.getItem(OPEN_KEY) !== 'closed';
  } catch {
    return true;
  }
}

/** Remembers whether the dock is open; a refused write holds for this page only. */
export function writeOpen(store: Pick<Storage, 'setItem'> | undefined, open: boolean): void {
  try {
    store?.setItem(OPEN_KEY, open ? 'open' : 'closed');
  } catch {
    // Storage refused the write: the choice holds for this page only.
  }
}

/** Whether a key press is ⌘J or Ctrl+J. */
export function isManagerShortcut(
  event: Pick<KeyboardEvent, 'metaKey' | 'ctrlKey' | 'altKey' | 'key'>,
): boolean {
  return (event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'j';
}

/** Opens the Manager from anywhere on the page, looking at `ask` when it is given. */
export const openManager = (ask?: ManagerAsk) =>
  window.dispatchEvent(new CustomEvent<ManagerAsk | null>(OPEN_EVENT, { detail: ask ?? null }));

/** Whether the address asks for the Manager open: `#manager` on any place. */
export const wantsManager = (): boolean =>
  typeof window !== 'undefined' && window.location.hash === '#manager';

/** Runs `onAsk` for each press of an "Ask manager" button (`null` for a bare open). */
export function useManagerAsks(onAsk: (ask: ManagerAsk | null) => void): void {
  useEffect(() => {
    const listen = (event: Event) => onAsk((event as CustomEvent<ManagerAsk | null>).detail);
    window.addEventListener(OPEN_EVENT, listen);
    return () => window.removeEventListener(OPEN_EVENT, listen);
  }, [onAsk]);
}

/** What the page shows that its address cannot say, such as Attention's count or a run's status, for the Manager's chip and questions. */
let placeWhat: { pathname: string; what: string } | undefined;
const whatListeners = new Set<() => void>();

const setPlaceWhat = (next: typeof placeWhat) => {
  placeWhat = next;
  for (const listener of whatListeners) listener();
};

export function usePlaceWhat(pathname: string): string | undefined {
  const what = useSyncExternalStore(
    (notify) => {
      whatListeners.add(notify);
      return () => whatListeners.delete(notify);
    },
    () => (placeWhat?.pathname === pathname ? placeWhat.what : undefined),
    () => undefined,
  );
  return what;
}

/** A page publishes what it shows for the Manager's chip and questions; it is withdrawn when the page unmounts. */
export function usePublishPlaceWhat(what: string | undefined): void {
  const { pathname } = useLocation();
  useEffect(() => {
    if (what === undefined) return;
    setPlaceWhat({ pathname, what });
    return () => setPlaceWhat(undefined);
  }, [pathname, what]);
}

/**
 * The docked Manager's state, kept in the browser; ⌘J or Ctrl+J toggles it. Where the dock is not
 * drawn, `onShortcut` takes the shortcut instead and the remembered state is left alone.
 */
export function useManagerDock(onShortcut?: () => void): { open: boolean; toggle: () => void } {
  const [open, setOpen] = useState(() => readOpen(storage()) || wantsManager());
  const toggle = useCallback(() => setOpen((was) => !was), []);
  useEffect(() => {
    writeOpen(storage(), open);
  }, [open]);
  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_EVENT, onOpen);
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (isManagerShortcut(event)) {
        event.preventDefault();
        (onShortcut ?? toggle)();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggle, onShortcut]);
  return { open, toggle };
}

/** Whether the viewport is a phone's. Server rendering and tests see a desktop. */
export function usePhone(): boolean {
  return useSyncExternalStore(
    (notify) => {
      const query = window.matchMedia(PHONE_QUERY);
      query.addEventListener('change', notify);
      return () => query.removeEventListener('change', notify);
    },
    () => window.matchMedia(PHONE_QUERY).matches,
    () => false,
  );
}
