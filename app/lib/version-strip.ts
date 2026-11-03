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

/** A shared pin that labels none of this factory's versions. */
interface PendingRow extends Trailers {
  digest: null;
  first_run_at: null;
  pin_sha: string;
  reason: string | null;
  committed_at: Date;
}

export type VersionStripRow = VersionRow | PendingRow;

export const NOT_RECORDED = 'not recorded';

/** Said on the Decisions and Versions screens: neither is one factory's own (PRD 11.5, #155). */
export const SHARED_PROCESS = 'Decisions and versions come from the shared factory process.';

export interface StripEntry {
  digest: string | null;
  pin: string | null;
  /** The labelled pin's UTC `YYYY-MM-DD` commit date, or `not recorded`. */
  date: string;
  reason: string;
  hypothesis: string;
  measure: string;
}

/** A pin's reason or trailer, or `not recorded` when the commit gave none. */
export const recorded = (text: string | null): string =>
  text === null || text.trim() === '' ? NOT_RECORDED : text;

/** Oldest first; a pin that has not run yet is dated by its commit. */
export function stripEntries(rows: readonly VersionStripRow[]): StripEntry[] {
  const at = (row: VersionStripRow) => (row.digest === null ? row.committed_at : row.first_run_at);
  return [...rows]
    .sort((a, b) => at(a).getTime() - at(b).getTime())
    .map((row) => ({
      digest: row.digest,
      pin: row.pin_sha,
      date: row.committed_at?.toISOString().slice(0, 10) ?? NOT_RECORDED,
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
