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

/**
 * What the shell shows for the URL's factory. A key the server serves is always the `screen`,
 * even before it has a row in the live list (a new factory shows its empty states). Any other key
 * is a factory when the switcher's live list names it: once listed it is the `screen`, and once
 * the list is in without it, it is `unknown`. While the list loads nothing is called unknown: a
 * key the server does not serve is held (`waiting`), because sealing for it would read as an
 * outage. When the list itself fails, the key cannot be checked and the screen shows as before.
 */
export type UrlFactoryView = 'screen' | 'unknown' | 'waiting';

export function urlFactoryView({
  inUrl,
  listed,
  served,
}: {
  inUrl: string | undefined;
  listed: Listed;
  /** The factories the server seals for, once its configuration is in. */
  served: readonly string[] | undefined;
}): UrlFactoryView {
  if (inUrl === undefined || listed.status === 'error') return 'screen';
  if (served?.includes(inUrl)) return 'screen';
  if (listed.status === 'ready') return listed.names.includes(inUrl) ? 'screen' : 'unknown';
  return served === undefined || served.includes(inUrl) ? 'screen' : 'waiting';
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

/**
 * The rows of `mc.factories` the switcher lists: only the factories the server shows (its
 * factories file). `migrate` never deletes a row, so a factory dropped from the file, or a row
 * only a fixture adds, stays in the table; with one factory in the file the switcher lists one.
 */
export function shownRows<Row extends { factory: string }>(
  rows: readonly Row[] | undefined,
  factories: readonly string[] | undefined,
): Row[] | undefined {
  if (rows === undefined || factories === undefined) return undefined;
  return rows.filter((row) => factories.includes(row.factory));
}

/** The switcher's order: the default factory first, then the rest by name. */
export function switcherEntries<Row extends { factory: string; is_default: boolean }>(
  rows: readonly Row[],
): Row[] {
  return [...rows].sort(
    (a, b) => Number(b.is_default) - Number(a.is_default) || a.factory.localeCompare(b.factory),
  );
}
