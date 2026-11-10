/**
 * What the merge queue's run records, parsed from the JSON text a live query returns (Realtime
 * refuses a set-returning function to expand an array, so the browser does). Pure, no React.
 */

/** The pull requests of a merge-queue lap's list; anything but an array of positive integers gives none. */
export function mergedPulls(prs: string): number[] {
  try {
    const parsed: unknown = JSON.parse(prs);
    return Array.isArray(parsed)
      ? parsed.filter((n): n is number => Number.isInteger(n) && n > 0)
      : [];
  } catch {
    return [];
  }
}

const isPositiveInteger = (n: unknown): n is number => Number.isInteger(n) && (n as number) > 0;

/**
 * The pull request and issue of each item in a merge-queue run's `facts` output (`items`); an entry
 * without both gives none, and anything unparsable gives none.
 */
export function mergeItems(items: string | null): { pr: number; issue: number }[] {
  if (items === null) return [];
  try {
    const parsed: unknown = JSON.parse(items);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry: unknown) => {
      if (typeof entry !== 'object' || entry === null) return [];
      const { pr, item } = entry as Record<string, unknown>;
      const prNumber = (pr as { number?: unknown } | null)?.number;
      const issue = (item as { number?: unknown } | null)?.number;
      return isPositiveInteger(prNumber) && isPositiveInteger(issue)
        ? [{ pr: prNumber, issue }]
        : [];
    });
  } catch {
    return [];
  }
}

/**
 * The pull requests a merge-queue run's `facts` output (`items`) claims; anything unparsable gives
 * none.
 */
export function claimedPulls(items: string | null): number[] {
  if (items === null) return [];
  try {
    const parsed: unknown = JSON.parse(items);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry: unknown) => {
      if (typeof entry !== 'object' || entry === null) return [];
      const prNumber = ((entry as Record<string, unknown>).pr as { number?: unknown } | null)
        ?.number;
      return isPositiveInteger(prNumber) ? [prNumber] : [];
    });
  } catch {
    return [];
  }
}
