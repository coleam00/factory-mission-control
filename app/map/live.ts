/**
 * What the factory map's chips count (PRD 4.1 "Live"), from the live rows: the laps on each card
 * and today's merges from `home-map`, Build's workable issues from `health-workable`, the
 * owner's open items from `owner-queue` and the work orders with open issues from `work-orders`. Every chip keeps the items it counted,
 * which the details strip's Right now lists (invariant 4). Pure, no React.
 */
import type { HealthWorkableRow } from '../lib/health';
import { pullUrl } from '../lib/one-lap';
import type { OwnerQueueRow } from '../lib/owner-queue';
import type { PanelState } from '../live/LivePanel';
import {
  allCards,
  type Card,
  type Chip,
  cardChain,
  cardForStep,
  type FactoryMap,
  type List,
  stepPath,
} from './factory-map';

/** One row of `db/queries/home-map.sql`. */
export interface HomeMapRow {
  kind: 'version' | 'lap' | 'failing' | 'waiting' | 'queues' | 'merged';
  /** A lap's run. */
  run_id: string | null;
  /** A lap's workflow. */
  workflow: string | null;
  /** A lap's running steps by Archon's step id, newest first; null while none runs. */
  steps: string[] | null;
  /** A lap's issue (its claim, else its number input), or a failing pull request. */
  number: number | null;
  title: string | null;
  url: string | null;
  /** When a merged lap's land or record step finished. */
  at: Date | null;
  /** A merge-queue lap's merged pull requests, as the JSON text of an array of numbers. */
  prs: string | null;
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
  /** Null for an attention item whose run names no issue. */
  number: number | null;
  title: string;
  url: string | null;
}

/** A merge a chip counts: the lap that landed it, and the issue or pull request it merged. */
export interface MapMerge {
  run: string;
  number: number | null;
  at: Date;
}

/** One row of `db/queries/work-orders.sql`: a work order, the issues carrying one `work-order:` label. */
export interface WorkOrderRow {
  name: string;
  total_count: number;
  open_count: number;
  merged_count: number;
  /** The `lands-on:<target>` label its issues carry, when one does. */
  lands_on: string | null;
  /** When its latest issue closed; null while none has. */
  last_closed_at: Date | null;
}

/** One row of `db/queries/map-right-now.sql`: a run's gate decisions, or a finished deploy. */
export interface MapRightNowRow {
  kind: 'outcomes' | 'deploys';
  run_id: string;
  at: Date | null;
  /** A gate row's sweep decisions, as the JSON text of an array. */
  decisions: string | null;
  /** A gate row's pull requests the record step read back as merged, as the JSON text of an array of numbers. */
  merged: string | null;
  /** The number of the pull request the record step asked about, when it did. */
  asked: string | null;
  /** A gate row's `facts` items, the pull requests the run listed, as the JSON text of an array. */
  claimed: string | null;
  revision: string | null;
  health: string | null;
  status: 'verified' | 'failed' | null;
  repository: string;
}

/**
 * What the gate did with a pull request in a run. `merged` is read back by the record step;
 * `sent back` and `asked` are the sweep's decision, which the record step may still park or skip.
 */
export interface GateOutcome {
  run: string;
  number: number;
  outcome: 'merged' | 'sent back' | 'asked';
  reason: string;
  url: string;
  at: Date | null;
}

export interface LatestDeploy {
  run: string;
  revision: string | null;
  health: string | null;
  verified: boolean;
  at: Date | null;
}

export interface CardLive {
  here: MapLap[];
  queued?: MapItem[];
  failing?: MapItem[];
  waiting?: MapItem[];
  merged?: MapMerge[];
  orders?: WorkOrderRow[];
  /** Chips whose source failed: not zero, unknown, so drawn as such. */
  unavailable?: Chip[];
  gate?: GateOutcome[];
  /** The latest deploy; null when the factory never deployed. */
  deploy?: LatestDeploy | null;
  /** The work orders with open issues, each with where it lands. */
  lands?: WorkOrderRow[];
  /** Lists whose source failed. */
  listsUnavailable?: List[];
}

export interface MapSources {
  map: readonly HomeMapRow[];
  workable?: readonly HealthWorkableRow[];
  owner?: readonly OwnerQueueRow[];
  orders?: readonly WorkOrderRow[];
  rightNow?: readonly MapRightNowRow[];
  /** A source in `error` keeps its rows, but its chip is unavailable, never a count. */
  states?: {
    workable?: PanelState;
    owner?: PanelState;
    orders?: PanelState;
    rightNow?: PanelState;
  };
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

/** The pull requests of a merge-queue lap's list; anything but an array of positive integers gives none. */
function mergedPulls(prs: string): number[] {
  try {
    const parsed: unknown = JSON.parse(prs);
    return Array.isArray(parsed)
      ? parsed.filter((n): n is number => Number.isInteger(n) && n > 0)
      : [];
  } catch {
    return [];
  }
}

/**
 * The merges of `now`'s local day, newest first: a loop lap whose land step merged is one, a
 * merge-queue lap is one per pull request its record step read back as merged.
 */
export function mergedToday(rows: readonly HomeMapRow[], now: Date): MapMerge[] {
  return rows
    .flatMap((row): MapMerge[] => {
      if (row.kind !== 'merged' || row.run_id === null || row.at === null) return [];
      if (!sameLocalDay(row.at, now)) return [];
      const { run_id: run, at } = row;
      if (row.prs === null) return [{ run, number: row.number, at }];
      return mergedPulls(row.prs).map((number) => ({ run, number, at }));
    })
    .sort(
      (a, b) =>
        b.at.getTime() - a.at.getTime() ||
        a.run.localeCompare(b.run) ||
        (a.number ?? 0) - (b.number ?? 0),
    );
}

function jsonArray(text: string | null): unknown[] {
  if (text === null) return [];
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

const newestFirst = (a: MapRightNowRow, b: MapRightNowRow) =>
  (b.at?.getTime() ?? Number.NEGATIVE_INFINITY) - (a.at?.getTime() ?? Number.NEGATIVE_INFINITY) ||
  a.run_id.localeCompare(b.run_id);

/**
 * The gate's recent outcomes, newest run first and in the sweep's order within a run. A pull
 * request the record step read back as merged is merged whatever the sweep said; else a `return`
 * decision is listed as sent back, and an ask only when the record step raised it. Those two are
 * the sweep's decision: the record step may still park, wait on or skip the pull request. Only the
 * first decision per number counts, and a number the run's facts did not list is dropped, as the
 * record step's `decide()` does (`merge-queue/scripts/record.ts`). A waiting decision, or an ask
 * not raised, is not listed.
 */
export function gateOutcomes(rows: readonly MapRightNowRow[]): GateOutcome[] {
  return rows
    .filter((row) => row.kind === 'outcomes')
    .sort(newestFirst)
    .flatMap((row) => {
      const merged = new Set(mergedPulls(row.merged ?? '[]'));
      const asked = row.asked === null ? null : Number(row.asked);
      const claimed = new Set(
        jsonArray(row.claimed).map(
          (item) => (item as { pr?: { number?: unknown } } | null)?.pr?.number,
        ),
      );
      const seen = new Set<number>();
      return jsonArray(row.decisions).flatMap((decision): GateOutcome[] => {
        if (typeof decision !== 'object' || decision === null) return [];
        const { number, action, reason } = decision as Record<string, unknown>;
        if (!Number.isInteger(number) || (number as number) < 1 || typeof reason !== 'string') {
          return [];
        }
        const n = number as number;
        if (seen.has(n) || !claimed.has(n)) return [];
        seen.add(n);
        const outcome = merged.has(n)
          ? 'merged'
          : action === 'return'
            ? 'sent back'
            : action === 'ask' && asked === n
              ? 'asked'
              : null;
        return outcome === null
          ? []
          : [
              {
                run: row.run_id,
                number: n,
                outcome,
                reason,
                url: pullUrl(row.repository, n),
                at: row.at,
              },
            ];
      });
    });
}

/** The newest finished deploy, from the queue's factory-deploy or the old loop's deploy include; null when none. */
export function latestDeploy(rows: readonly MapRightNowRow[]): LatestDeploy | null {
  const [latest] = rows.filter((row) => row.kind === 'deploys').sort(newestFirst);
  return latest === undefined
    ? null
    : {
        run: latest.run_id,
        revision: latest.revision,
        health: latest.health,
        verified: latest.status === 'verified',
        at: latest.at,
      };
}

const byNumber = (a: MapItem, b: MapItem) =>
  (a.number ?? Number.POSITIVE_INFINITY) - (b.number ?? Number.POSITIVE_INFINITY) ||
  a.key.localeCompare(b.key);

/** Whether the factory is on the queues: it has run an intake or build queue. */
export const onQueues = (map: readonly HomeMapRow[]): boolean =>
  map.some((r) => r.kind === 'queues');

/**
 * The map's "here" rule: the card covering a running lap's deepest running step, with that step's
 * path. Undefined for a row that is not a lap with a run, one with no running step, or one whose
 * step no card covers.
 */
export function lapCard(
  factoryMap: FactoryMap,
  row: HomeMapRow,
): { card: Card; step: string; run: string; workflow: string } | undefined {
  if (row.kind !== 'lap' || row.run_id === null || row.workflow === null) return undefined;
  const step = deepestStep(row.steps);
  if (step === undefined) return undefined;
  const card = cardForStep(factoryMap, row.workflow, stepPath(step));
  return card === undefined
    ? undefined
    : { card, step: stepPath(step), run: row.run_id, workflow: row.workflow };
}

/** Open Archon attention items: paused runs waiting on a person, named by their issue when they have one. */
function attentionItems(map: readonly HomeMapRow[]): MapItem[] {
  return map
    .filter((r) => r.kind === 'waiting' && r.run_id !== null)
    .map((r) => ({
      key: `attention-${r.run_id}`,
      number: r.number,
      title: r.title ?? `${r.workflow} run ${String(r.run_id).slice(0, 8)}`,
      url: r.url,
    }))
    .sort(byNumber);
}

/**
 * What the Manager's waiting chip counts. A factory on the queues (it has run an intake or build
 * queue) waits on attention items alone; one on the old loop on its owner's open items, as ever.
 */
function waitingItems({
  map,
  owner,
  states = {},
}: MapSources): MapItem[] | 'unavailable' | undefined {
  const attention = attentionItems(map);
  if (onQueues(map)) return attention;
  if (states.owner === 'error') return 'unavailable';
  if (!owner) return undefined;
  return [
    ...owner.map((r) => ({
      key:
        r.kind === 'issue'
          ? `issue-${r.issue_number}`
          : `question-${r.issue_number}-${r.question_number}`,
      number: r.issue_number,
      title: r.title,
      url: r.url,
    })),
    ...attention,
  ].sort(byNumber);
}

/** The items each chip kind counts; a source not delivered yet counts nothing and draws no chip. */
function chipItems(
  sources: MapSources,
  now: Date,
): { [K in Chip]?: Required<CardLive>[K] | 'unavailable' } {
  const { map, workable, orders, states = {} } = sources;
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
    waiting: waitingItems(sources),
    merged: mergedToday(map, now),
    ...(states.orders === 'error' && { orders: 'unavailable' as const }),
    ...(orders && states.orders !== 'error' && { orders: orders.filter((o) => o.open_count > 0) }),
  };
}

/** What one list of a card shows: unavailable when its source failed, nothing until it is delivered. */
function listInto(entry: CardLive, list: List, { orders, rightNow, states = {} }: MapSources) {
  const source = list === 'lands' ? states.orders : states.rightNow;
  if (source === 'error') {
    entry.listsUnavailable = [...(entry.listsUnavailable ?? []), list];
  } else if (list === 'lands') {
    if (orders) entry.lands = orders.filter((o) => o.open_count > 0);
  } else if (rightNow) {
    if (list === 'outcomes') entry.gate = gateOutcomes(rightNow);
    else entry.deploy = latestDeploy(rightNow);
  }
}

/**
 * Each card's live state: the laps of the factory on a step it covers, each counted once per level
 * on the card covering its deepest running step there (Build at the root, Deliver in its view),
 * and the items of each chip the card carries.
 */
export function cardLive(
  factoryMap: FactoryMap,
  sources: MapSources,
  now: Date,
): Map<string, CardLive> {
  const cards = allCards(factoryMap);
  const live = new Map(cards.map((card): [string, CardLive] => [card.id, { here: [] }]));
  for (const row of sources.map) {
    const placed = lapCard(factoryMap, row);
    if (placed === undefined) continue;
    const lap: MapLap = {
      run: placed.run,
      step: placed.step,
      issue: row.number === null ? null : { number: row.number, title: row.title, url: row.url },
    };
    for (const card of cardChain(factoryMap, placed.workflow, placed.step)) {
      live.get(card.id)?.here.push(lap);
    }
  }
  const items = chipItems(sources, now);
  for (const card of cards) {
    const entry = live.get(card.id) as CardLive;
    entry.here.sort(
      (a, b) => (a.issue?.number ?? 0) - (b.issue?.number ?? 0) || a.run.localeCompare(b.run),
    );
    for (const chip of card.chips ?? []) {
      const counted = items[chip];
      if (counted === 'unavailable') entry.unavailable = [...(entry.unavailable ?? []), chip];
      else if (counted !== undefined) Object.assign(entry, { [chip]: counted });
    }
    for (const list of card.lists ?? []) listInto(entry, list, sources);
  }
  return live;
}

/** Whether the version the address names is recorded: always, for the current version. */
export const versionRecorded = (rows: readonly HomeMapRow[], at: string | null) =>
  at === null || rows.some((r) => r.kind === 'version');
