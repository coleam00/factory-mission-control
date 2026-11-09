import { type ReactElement, useCallback, useEffect, useState, useSyncExternalStore } from 'react';

const OPEN_KEY = 'mc.manager.open';
const OPEN_EVENT = 'mc:manager-open';

/** Under this width there is no side nav and no docked panel: a top bar and a tab bar instead. */
export const PHONE_QUERY = '(max-width: 759.98px)';

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

/** Opens the Manager dock from anywhere on the page. */
export const openManager = () => window.dispatchEvent(new Event(OPEN_EVENT));

/** The docked Manager's state, kept in the browser; ⌘J or Ctrl+J toggles it. */
export function useManagerDock(): { open: boolean; toggle: () => void } {
  const [open, setOpen] = useState(() => readOpen(storage()));
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
        toggle();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggle]);
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

/** The Manager's panel: a docked column on the desktop, the whole screen on the phone. */
export function ManagerPanel({
  onClose,
  phone = false,
}: {
  onClose: () => void;
  phone?: boolean;
}): ReactElement {
  return (
    <aside
      aria-label="Manager"
      data-manager={phone ? 'tab' : 'dock'}
      className={`flex min-h-0 flex-col bg-[var(--v3-panel)] ${
        phone
          ? 'min-h-[calc(100vh-110px)] flex-1'
          : 'w-[var(--v3-manager-width)] shrink-0 border-l border-[color:var(--v3-line)]'
      }`}
    >
      <div className="flex items-center gap-2.5 border-b border-[color:var(--v3-line)] px-4 py-3.5">
        <b className="text-[14.5px] text-[color:var(--v3-fg)]">Manager</b>
        {phone ? null : (
          <button
            type="button"
            aria-label="Close the Manager"
            onClick={onClose}
            className="ml-auto cursor-pointer text-lg text-[color:var(--v3-fg-3)] hover:text-[color:var(--v3-fg)]"
          >
            ×
          </button>
        )}
      </div>
      <p className="px-4 py-3.5 text-[length:var(--v3-t-meta)] text-[color:var(--v3-fg-3)]">
        The Manager is not available yet.
      </p>
    </aside>
  );
}
