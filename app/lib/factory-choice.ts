/** Where the browser keeps the factory it showed last. */
export const REMEMBERED_KEY = 'mc:factory';

/** The factories the switcher's live query has listed so far. */
export type Listed =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; names: readonly string[] };

type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem'>;

/**
 * The factory every panel shows. The URL's factory wins; off a factory's pages it is the
 * remembered one, else the default. A remembered factory other than the default waits for the
 * live list (`undefined`), because sealing for a factory that has since been removed would be an
 * error; once listed it is shown, and when it is not listed, or the list fails, the default is.
 */
export function currentFactory({
  inUrl,
  remembered,
  fallback,
  listed,
}: {
  inUrl: string | undefined;
  remembered: string | undefined;
  fallback: string | undefined;
  listed: Listed;
}): string | undefined {
  if (inUrl !== undefined) return inUrl;
  if (remembered === undefined || remembered === fallback) return fallback;
  if (listed.status === 'loading') return undefined;
  return listed.status === 'ready' && listed.names.includes(remembered) ? remembered : fallback;
}

/** The factory to remember: the URL's, once the live list confirms it exists. */
export function toRemember(inUrl: string | undefined, listed: Listed): string | undefined {
  return inUrl !== undefined && listed.status === 'ready' && listed.names.includes(inUrl)
    ? inUrl
    : undefined;
}

/** Storage can be missing or throw (a private window, a full quota): nothing is remembered then. */
export function readRemembered(storage: Storage | undefined): string | undefined {
  try {
    return storage?.getItem(REMEMBERED_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

export function remember(storage: Storage | undefined, factory: string): void {
  try {
    storage?.setItem(REMEMBERED_KEY, factory);
  } catch {
    // Not remembered; the URL still names the factory.
  }
}

/** The switcher's order: the default factory first, then the rest by name. */
export function switcherEntries<Row extends { factory: string; is_default: boolean }>(
  rows: readonly Row[],
): Row[] {
  return [...rows].sort(
    (a, b) => Number(b.is_default) - Number(a.is_default) || a.factory.localeCompare(b.factory),
  );
}
