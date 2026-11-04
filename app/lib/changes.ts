/**
 * The Changes timeline: versions, their verdicts and the decisions made under them, newest first,
 * merged from the rows the version strip, the improvements ledger and the decisions timeline
 * already read. Pure, no React.
 */

import {
  lapsWanted,
  ledger,
  type LedgerRow,
  type TestingEntry,
  type TimelineRow,
  type VerdictEntry,
} from './decisions-ledger';
import { newestVersionWithLaps, type ScorecardRow } from './scorecard';
import { NOT_RECORDED, type StripEntry, stripEntries, type VersionStripRow } from './version-strip';

export type ChangeItem =
  | {
      kind: 'version';
      entry: StripEntry;
      verdict: VerdictEntry | null;
      testing: TestingEntry | null;
      /** The decisions whose `Version:` names this version's pin, newest first. */
      decisions: TimelineRow[];
    }
  | { kind: 'decision'; decision: TimelineRow }
  | { kind: 'verdict'; verdict: VerdictEntry };

const dateOf = (item: ChangeItem): string =>
  item.kind === 'version'
    ? item.entry.date
    : item.kind === 'decision'
      ? item.decision.date
      : item.verdict.date;

/**
 * Versions newest first. A decision whose `Version:` names one pin goes under the row of the first
 * digest this factory ran after that pin, else under the oldest row of that pin (a pin not yet
 * run). A decision or verdict that names no pin or several gets its own row at its date, before
 * the first version that has a recorded date earlier than it.
 */
export function changeTimeline(
  strip: readonly VersionStripRow[],
  ledgerRows: readonly LedgerRow[],
  decisions: readonly TimelineRow[],
): ChangeItem[] {
  const { testing, verdicts } = ledger(ledgerRows);
  const verdictOf = new Map(verdicts.filter((v) => v.unmatched === null).map((v) => [v.pin, v]));
  const testingOf = new Map(testing.map((t) => [t.pin, t]));
  const versions = stripEntries(strip)
    .reverse()
    .map((entry): ChangeItem & { kind: 'version' } => ({
      kind: 'version',
      entry,
      verdict: (entry.pin !== null && verdictOf.get(entry.pin)) || null,
      testing: (entry.pin !== null && testingOf.get(entry.pin)) || null,
      decisions: [],
    }));

  const standalone: ChangeItem[] = [];
  const newestFirst = [...decisions].sort(
    (a, b) => b.date.localeCompare(a.date) || a.title.localeCompare(b.title),
  );
  for (const decision of newestFirst) {
    const home =
      decision.pin_sha === null
        ? undefined
        : (versions.find((v) => decision.digest !== null && v.entry.digest === decision.digest) ??
          versions.findLast((v) => v.entry.pin === decision.pin_sha));
    if (home === undefined) standalone.push({ kind: 'decision', decision });
    else home.decisions.push(decision);
  }
  for (const verdict of [...verdicts].reverse()) {
    if (verdict.unmatched !== null) standalone.push({ kind: 'verdict', verdict });
  }
  standalone.sort((a, b) => dateOf(b).localeCompare(dateOf(a)));

  const items: ChangeItem[] = [...versions];
  for (const item of standalone) {
    const at = items.findIndex(
      (other) =>
        other.kind === 'version' &&
        other.entry.date !== NOT_RECORDED &&
        other.entry.date < dateOf(item),
    );
    items.splice(at === -1 ? items.length : at, 0, item);
  }
  return items;
}

/**
 * The chip text of a version being tested: laps so far of the laps its Measure wants; no count
 * before a lap has run, which the version strip decides by its digest being null.
 */
export function testingChip(t: TestingEntry, digest: string | null): string {
  if (digest === null || t.laps === 0) return 'testing';
  const wanted = lapsWanted(t.measure);
  return wanted === null ? `testing, ${t.laps} laps` : `testing, ${t.laps} of ${wanted} laps`;
}

/** The two versions compared, `a` the older. */
export interface Pair {
  a?: string;
  b?: string;
}

/** Digests of the versions that have run, newest first: what can be paired. */
const digestsNewestFirst = (items: readonly ChangeItem[]): string[] =>
  items.flatMap((item) =>
    item.kind === 'version' && item.entry.digest !== null ? [item.entry.digest] : [],
  );

/** How many versions on the timeline can be compared. */
export const selectableVersions = (items: readonly ChangeItem[]): number =>
  digestsNewestFirst(items).length;

/** `digests` that are versions on the timeline, older first, without repeats. */
function inTimelineOrder(
  items: readonly ChangeItem[],
  digests: readonly (string | null)[],
): string[] {
  const order = digestsNewestFirst(items);
  return [...new Set(digests)]
    .filter((d): d is string => d !== null && order.includes(d))
    .sort((x, y) => order.indexOf(y) - order.indexOf(x));
}

/** The digests the address names (`a`, `b`) that are not versions on the timeline. */
export function unknownDigests(
  items: readonly ChangeItem[],
  a: string | null,
  b: string | null,
): string[] {
  const known = new Set(digestsNewestFirst(items));
  return [...new Set([a, b])].filter((d): d is string => d !== null && !known.has(d));
}

/** The digest of the version row just older than `digest`, or null for the oldest or an unknown one. */
export function previousDigest(items: readonly ChangeItem[], digest: string): string | null {
  const order = digestsNewestFirst(items);
  return order.includes(digest) ? (order[order.indexOf(digest) + 1] ?? null) : null;
}

/**
 * The pair the address names (`a` and `b`, in either order), without any digest that is not a
 * version here; with none left, the default: the newest version with laps against the version
 * before it, when that digest is a version here. Until the scorecard's rows arrive the default names nothing.
 */
export function resolvePair(
  items: readonly ChangeItem[],
  scorecardRows: readonly ScorecardRow[] | undefined,
  a: string | null,
  b: string | null,
): Pair & { isDefault: boolean } {
  const [first, second] = inTimelineOrder(items, [a, b]);
  if (first !== undefined)
    return second === undefined
      ? { a: first, isDefault: false }
      : { a: first, b: second, isDefault: false };
  const onTimeline = new Set(digestsNewestFirst(items));
  const newest =
    scorecardRows === undefined
      ? null
      : newestVersionWithLaps(
          scorecardRows.filter((row) => 'digest' in row && onTimeline.has(row.digest)),
        );
  if (newest === null) return { isDefault: true };
  const previous = previousDigest(items, newest);
  return previous === null
    ? { a: newest, isDefault: true }
    : { a: previous, b: newest, isDefault: true };
}

/** The pair after pressing `digest`'s box: unchecks it, else adds it, replacing the older of two. */
export function togglePair(items: readonly ChangeItem[], pair: Pair, digest: string): Pair {
  const checked = [pair.a, pair.b].filter((d): d is string => d !== undefined);
  const next = checked.includes(digest)
    ? checked.filter((d) => d !== digest)
    : [...(checked.length < 2 ? checked : checked.slice(1)), digest];
  const [a, b] = inTimelineOrder(items, next);
  return b === undefined ? (a === undefined ? {} : { a }) : { a, b };
}

/** `params` naming `pair` as `a` and `b`, with every other parameter kept. */
export function pairSearch(params: URLSearchParams, pair: Pair): URLSearchParams {
  const next = new URLSearchParams(params);
  next.delete('a');
  next.delete('b');
  if (pair.a !== undefined) next.set('a', pair.a);
  if (pair.b !== undefined) next.set('b', pair.b);
  return next;
}
