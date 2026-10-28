/**
 * The decisions timeline and the improvements ledger, from the rows `db/queries/decisions-timeline.sql`
 * and `db/queries/improvements-ledger.sql` return; Realtime's client parses `timestamptz` into a
 * `Date`. Pure, no React.
 */

import { NOT_RECORDED, recorded } from './version-strip';

/**
 * One `DECISIONS.md` entry, with the one pin its `Version:` line names by a prefix of the pin's
 * sha or of its Archon sha, if any; `ambiguous` when the prefix matches several pins.
 */
export interface TimelineRow {
  /** `YYYY-MM-DD`, cast to text so no timezone moves it. */
  date: string;
  title: string;
  decision: string;
  why: string;
  replaces: string;
  version: string;
  pin_sha: string | null;
  ambiguous: boolean;
  /** The first digest this factory ran after that pin, before any later pin. */
  digest: string | null;
}

/**
 * One pin, with this factory's laps of the versions it labels and its latest verdict; or the latest
 * verdict whose prefix names no pin or several, with that prefix as `pin_sha` and no pin fields.
 */
export interface LedgerRow {
  pin_sha: string;
  reason: string | null;
  measure: string | null;
  committed_at: Date;
  laps: number;
  verdict: 'helped' | 'hurt' | 'inconclusive' | null;
  sentence: string | null;
  verdict_at: Date | null;
  /** 1 for a pin's row; for a verdict's own row, how many pins its prefix names (0 or several). */
  pin_matches: number;
}

/** Oldest first; entries on one date keep a stable order by title. */
export function timelineEntries(rows: readonly TimelineRow[]): TimelineRow[] {
  return [...rows].sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title));
}

/**
 * The lap count a Measure names, allowing up to two descriptors such as `consecutive complex`, or
 * null without one. Only a number right before `laps` (or `1 lap`) or its descriptors counts: in
 * `2 merges per hour over several laps` the 2 measures merges, so there is no lap count. A
 * descriptor is never a word such as `per` or `across` that would make the number count something
 * else per lap or across laps.
 */
export function lapsWanted(measure: string | null): number | null {
  const match = LAPS_WANTED.exec(measure ?? '');
  return match ? Number(match[1] ?? match[2]) : null;
}

/** A word that may sit between the number and `laps`: any but one that relates two counts. */
const DESCRIPTOR = String.raw`(?!(?:per|over|across|in|of|for|during|within|after|before|between|each|every)\s)[a-z-]+\s+`;
const LAPS_WANTED = new RegExp(
  String.raw`\b(?:(1)\s+(?:${DESCRIPTOR}){0,2}lap|(\d+)\s+(?:${DESCRIPTOR}){0,2}laps)(?![\w-])`,
  'i',
);

export interface TestingEntry {
  pin: string;
  reason: string;
  measure: string;
  laps: number;
  /** Laps still wanted before a verdict, never below 0; `not recorded` with no count. */
  waiting: number | typeof NOT_RECORDED;
}

export interface VerdictEntry {
  /** The pin's sha, or the verdict's prefix when it names no pin or several. */
  pin: string;
  /** Why the verdict is on no pin: its prefix names several pins, or none. */
  unmatched: 'ambiguous' | 'none' | null;
  reason: string;
  verdict: NonNullable<LedgerRow['verdict']>;
  sentence: string;
  /** UTC `YYYY-MM-DD` of the verdict commit. */
  date: string;
}

/**
 * Versions being tested (a Measure and no verdict), oldest pin first, and versions with a verdict,
 * oldest verdict first. A pin with neither a Measure nor a verdict is in neither.
 */
export function ledger(rows: readonly LedgerRow[]): {
  testing: TestingEntry[];
  verdicts: VerdictEntry[];
} {
  const testing = rows
    .filter((row) => row.verdict === null && (row.measure ?? '').trim() !== '')
    .sort((a, b) => a.committed_at.getTime() - b.committed_at.getTime())
    .map((row): TestingEntry => {
      const wanted = lapsWanted(row.measure);
      return {
        pin: row.pin_sha,
        reason: recorded(row.reason),
        measure: row.measure as string,
        laps: row.laps,
        waiting: wanted === null ? NOT_RECORDED : Math.max(0, wanted - row.laps),
      };
    });
  const verdicts = rows
    .flatMap((row) =>
      row.verdict === null || row.verdict_at === null
        ? []
        : [{ row, verdict: row.verdict, at: row.verdict_at }],
    )
    .sort((a, b) => a.at.getTime() - b.at.getTime())
    .map(
      ({ row, verdict, at }): VerdictEntry => ({
        pin: row.pin_sha,
        unmatched: row.pin_matches === 1 ? null : row.pin_matches > 1 ? 'ambiguous' : 'none',
        reason: recorded(row.reason),
        verdict,
        sentence: row.sentence ?? NOT_RECORDED,
        date: at.toISOString().slice(0, 10),
      }),
    );
  return { testing, verdicts };
}
