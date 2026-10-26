/**
 * The version strip's rows, as `db/queries/version-strip.sql` returns them; Realtime's client, like
 * node-postgres, parses `timestamptz` into a `Date`. Pure, no React.
 */

interface Trailers {
  hypothesis: string | null;
  measure: string | null;
}

/** A digest this factory's laps ran, labelled by the latest pin before its first run, if any. */
interface VersionRow extends Trailers {
  digest: string;
  first_run_at: Date;
  pin_sha: string | null;
  reason: string | null;
  committed_at: Date | null;
}

/** A pin no lap of this factory has started after yet. */
interface PendingRow extends Trailers {
  digest: null;
  first_run_at: null;
  pin_sha: string;
  reason: string;
  committed_at: Date;
}

export type VersionStripRow = VersionRow | PendingRow;

export const NOT_RECORDED = 'not recorded';

export interface StripEntry {
  digest: string | null;
  pin: string | null;
  /** UTC `YYYY-MM-DD`: the version's first run, or the pin's commit when it has not run yet. */
  date: string;
  reason: string;
  hypothesis: string;
  measure: string;
}

const recorded = (text: string | null): string =>
  text === null || text.trim() === '' ? NOT_RECORDED : text;

/** Oldest first; a pin that has not run yet is dated by its commit, so it sorts last. */
export function stripEntries(rows: readonly VersionStripRow[]): StripEntry[] {
  const at = (row: VersionStripRow) => (row.digest === null ? row.committed_at : row.first_run_at);
  return [...rows]
    .sort((a, b) => at(a).getTime() - at(b).getTime())
    .map((row) => ({
      digest: row.digest,
      pin: row.pin_sha,
      date: at(row).toISOString().slice(0, 10),
      reason: recorded(row.reason),
      hypothesis: recorded(row.hypothesis),
      measure: recorded(row.measure),
    }));
}

/** The one version's own scorecard, its digest URL-encoded. */
export function scorecardLink(factory: string, digest: string): string {
  return `/f/${encodeURIComponent(factory)}/scorecard?a=${encodeURIComponent(digest)}`;
}

/** The scorecard and diff of two versions by digest, read from `a` (the older) to `b`. */
export function compareLinks(
  factory: string,
  a: string,
  b: string,
): { scorecard: string; diff: string } {
  const query = `?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`;
  const base = `/f/${encodeURIComponent(factory)}`;
  return { scorecard: `${base}/scorecard${query}`, diff: `${base}/diff${query}` };
}
