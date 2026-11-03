/**
 * What the factory map's chips count (PRD 4.1 "Live"), from the live rows: the laps on each card
 * and today's merges from `home-map`, Build's workable issues from `health-workable` and the
 * owner's open items from `owner-queue`. Every chip keeps the items it counted,
 * which the details strip's Right now lists (invariant 4). Pure, no React.
 */
import type { HealthWorkableRow } from '../lib/health';
import type { OwnerQueueRow } from '../lib/owner-queue';
import type { PanelState } from '../live/LivePanel';
import { type Chip, cardForStep, type FactoryMap, stepPath } from './factory-map';

/** One row of `db/queries/home-map.sql`. */
export interface HomeMapRow {
  kind: 'version' | 'lap' | 'failing' | 'merged';
  /** A lap's run. */
  run_id: string | null;
  /** A lap's workflow. */
  workflow: string | null;
  /** A lap's running steps by Archon's step id, newest first; null while none runs. */
  steps: string[] | null;
  /** A lap's claimed issue, or a failing pull request. */
  number: number | null;
  title: string | null;
  url: string | null;
  /** When a merged lap's land step finished. */
  at: Date | null;
}

/** A lap on the map: its run, its claimed issue, and the step it counts on. */
export interface MapLap {
  run: string;
  /** The deepest running step's path. */
  step: string;
  issue: { number: number; title: string | null; url: string | null } | null;
}

/** An issue, a pull request or a question a chip counts. */
export interface MapItem {
  key: string;
  number: number;
  title: string;
  url: string | null;
}

/** A merge a chip counts: the lap that landed it. */
export interface MapMerge {
  run: string;
  issue: number | null;
  at: Date;
}

export interface CardLive {
  here: MapLap[];
  queued?: MapItem[];
  failing?: MapItem[];
  waiting?: MapItem[];
  merged?: MapMerge[];
  /** Chips whose source failed: not zero, unknown, so drawn as such. */
  unavailable?: Chip[];
}

export interface MapSources {
  map: readonly HomeMapRow[];
  workable?: readonly HealthWorkableRow[];
  owner?: readonly OwnerQueueRow[];
  /** A source in `error` keeps its rows, but its chip is unavailable, never a count. */
  states?: { workable?: PanelState; owner?: PanelState };
}

const depth = (step: string) => stepPath(step).split('/').length;

/** A lap's deepest running step, the newest of those as deep; undefined while none runs. */
export function deepestStep(steps: readonly string[] | null): string | undefined {
  let deepest: string | undefined;
  for (const step of steps ?? []) {
    if (deepest === undefined || depth(step) > depth(deepest)) deepest = step;
  }
  return deepest;
}

const sameLocalDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate();

/** The laps whose land step merged on `now`'s local day, newest first. */
export function mergedToday(rows: readonly HomeMapRow[], now: Date): MapMerge[] {
  return rows
    .flatMap((row) =>
      row.kind === 'merged' && row.run_id !== null && row.at !== null && sameLocalDay(row.at, now)
        ? [{ run: row.run_id, issue: row.number, at: row.at }]
        : [],
    )
    .sort((a, b) => b.at.getTime() - a.at.getTime() || a.run.localeCompare(b.run));
}

const byNumber = (a: MapItem, b: MapItem) => a.number - b.number || a.key.localeCompare(b.key);

/** The items each chip kind counts; a source not delivered yet counts nothing and draws no chip. */
function chipItems(
  { map, workable, owner, states = {} }: MapSources,
  now: Date,
): { [K in Chip]?: Required<CardLive>[K] | 'unavailable' } {
  return {
    failing: map
      .filter((r) => r.kind === 'failing' && r.number !== null)
      .map((r) => ({
        key: `pr-${r.number}`,
        number: Number(r.number),
        title: r.title ?? '',
        url: r.url,
      }))
      .sort(byNumber),
    ...(states.workable === 'error' && { queued: 'unavailable' as const }),
    ...(workable &&
      states.workable !== 'error' && {
        queued: workable
          .filter((r) => r.kind === 'issue' && r.issue_number !== null)
          .map((r) => ({
            key: `issue-${r.issue_number}`,
            number: Number(r.issue_number),
            title: r.title ?? '',
            url: r.url,
          }))
          .sort(byNumber),
      }),
    ...(states.owner === 'error' && { waiting: 'unavailable' as const }),
    ...(owner &&
      states.owner !== 'error' && {
        waiting: owner
          .map((r) => ({
            key:
              r.kind === 'issue'
                ? `issue-${r.issue_number}`
                : `question-${r.issue_number}-${r.question_number}`,
            number: r.issue_number,
            title: r.title,
            url: r.url,
          }))
          .sort(byNumber),
      }),
    merged: mergedToday(map, now),
  };
}

/**
 * Each card's live state: the laps of the factory on a step it covers, each counted once on the
 * card covering its deepest running step, and the items of each chip the card carries.
 */
export function cardLive(
  factoryMap: FactoryMap,
  sources: MapSources,
  now: Date,
): Map<string, CardLive> {
  const live = new Map(factoryMap.cards.map((card): [string, CardLive] => [card.id, { here: [] }]));
  for (const row of sources.map) {
    if (row.kind !== 'lap' || row.run_id === null || row.workflow === null) continue;
    const step = deepestStep(row.steps);
    if (step === undefined) continue;
    const card = cardForStep(factoryMap, row.workflow, stepPath(step));
    if (card === undefined) continue;
    live.get(card.id)?.here.push({
      run: row.run_id,
      step: stepPath(step),
      issue: row.number === null ? null : { number: row.number, title: row.title, url: row.url },
    });
  }
  const items = chipItems(sources, now);
  for (const card of factoryMap.cards) {
    const entry = live.get(card.id) as CardLive;
    entry.here.sort(
      (a, b) => (a.issue?.number ?? 0) - (b.issue?.number ?? 0) || a.run.localeCompare(b.run),
    );
    for (const chip of card.chips ?? []) {
      const counted = items[chip];
      if (counted === 'unavailable') entry.unavailable = [...(entry.unavailable ?? []), chip];
      else if (counted !== undefined) Object.assign(entry, { [chip]: counted });
    }
  }
  return live;
}

/** Whether the version the address names is recorded: always, for the current version. */
export const versionRecorded = (rows: readonly HomeMapRow[], at: string | null) =>
  at === null || rows.some((r) => r.kind === 'version');
