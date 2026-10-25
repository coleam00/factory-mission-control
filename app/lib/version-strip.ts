/** The version strip's rows, as `db/queries/version-strip.sql` returns them. Pure, no React. */

export interface VersionStripRow {
  /** Null for a pin no lap of this factory has run after yet. */
  digest: string | null;
  first_run_at: string | null;
  /** Null for a version whose first run predates every pin. */
  pin_sha: string | null;
  reason: string | null;
  hypothesis: string | null;
  measure: string | null;
  committed_at: string | null;
}

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

/**
 * Epoch ms of a Postgres timestamp in any form it reaches the browser in: ISO with `Z`,
 * ISO with `+00:00`, or Postgres text (`2026-10-01 08:00:00+00`), whose hour-only offset
 * `Date` does not parse.
 */
function epochMs(timestamp: string): number {
  return Date.parse(timestamp.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00'));
}

export function utcDay(timestamp: string): string {
  return new Date(epochMs(timestamp)).toISOString().slice(0, 10);
}

const recorded = (text: string | null): string =>
  text === null || text.trim() === '' ? NOT_RECORDED : text;

/** Oldest first; a pin that has not run yet is dated by its commit, so it sorts last. */
export function stripEntries(rows: readonly VersionStripRow[]): StripEntry[] {
  const at = (row: VersionStripRow) => row.first_run_at ?? row.committed_at ?? '';
  return [...rows]
    .sort((a, b) => epochMs(at(a)) - epochMs(at(b)))
    .map((row) => ({
      digest: row.digest,
      pin: row.pin_sha,
      date: utcDay(at(row)),
      reason: recorded(row.reason),
      hypothesis: recorded(row.hypothesis),
      measure: recorded(row.measure),
    }));
}

/** The scorecard and diff of two versions by digest, read from `a` (the older) to `b`. */
export function compareLinks(
  factory: string,
  a: string,
  b: string,
): { scorecard: string; diff: string } {
  const query = `?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`;
  return {
    scorecard: `/f/${encodeURIComponent(factory)}/scorecard${query}`,
    diff: `/diff${query}`,
  };
}
