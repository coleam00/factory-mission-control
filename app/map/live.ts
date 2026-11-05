/**
 * What the factory map's chips count (PRD 4.1 "Live"), from the live rows: the laps on each card
 * and today's merges from `home-map`, Build's workable issues from `health-workable`, the
 * owner's open items from `owner-queue` and the work orders with open issues from `work-orders`. Every chip keeps the items it counted,
 * which the details strip's Right now lists (invariant 4). Pure, no React.
 */
import {
  type AttentionItem,
  type AttentionRow,
  attentionOrigin,
  attentionTitle,
  attentionItems as parseAttention,
  recommendedChoice,
} from '../lib/attention';
import { formatElapsed } from '../lib/format';
import {
  CAUSE_LABEL,
  failedLaps,
  type HealthRunRow,
  type HealthStepRow,
  type HealthWorkableRow,
  overdueSteps,
  waitingRuns,
} from '../lib/health';
import { mergedPulls } from '../lib/merge-queue';
import { consoleUrl } from '../lib/one-lap';
import type { OwnerQueueRow } from '../lib/owner-queue';
import type { PanelState } from '../live/LivePanel';
import {
  type Asks,
  allCards,
  type Card,
  type Chip,
  cardChain,
  cardForStep,
  type FactoryMap,
  levelsOf,
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
  /** What Right now says beside it when it is not the chip's own word: a question's recommendation. */
  note?: string;
}

/** One thing wrong with the factory, for the Manager's Right now: a run in the console. */
export interface MapHealth {
  key: string;
  /** What is wrong, in plain words. */
  note: string;
  run: string;
  /** The run in the factory's Archon console. */
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

export interface CardLive {
  here: MapLap[];
  queued?: MapItem[];
  failing?: MapItem[];
  waiting?: MapItem[];
  /** Every open question, which the Manager's Right now lists in place of its `waiting` ones. */
  questions?: MapItem[];
  /** Runs pending or paused and failed runs by cause. */
  health?: MapHealth[];
  /** The step rows whose overdue ones the view works out against its own ticking clock. */
  steps?: readonly HealthStepRow[];
  /** The health queries failed: not healthy, unknown. */
  healthUnavailable?: boolean;
  merged?: MapMerge[];
  orders?: WorkOrderRow[];
  /** Chips whose source failed: not zero, unknown, so drawn as such. */
  unavailable?: Chip[];
}

export interface MapSources {
  map: readonly HomeMapRow[];
  workable?: readonly HealthWorkableRow[];
  owner?: readonly OwnerQueueRow[];
  orders?: readonly WorkOrderRow[];
  /** The open Archon attention items with their labels, which the question cards count. */
  attention?: readonly AttentionRow[];
  healthRuns?: readonly HealthRunRow[];
  healthSteps?: readonly HealthStepRow[];
  /** A source in `error` keeps its rows, but its chip is unavailable, never a count. */
  states?: {
    workable?: PanelState;
    owner?: PanelState;
    orders?: PanelState;
    attention?: PanelState;
    healthRuns?: PanelState;
    healthSteps?: PanelState;
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
  }
  countQuestions(factoryMap, live, sources);
  return live;
}

/** Whether the version the address names is recorded: always, for the current version. */
export const versionRecorded = (rows: readonly HomeMapRow[], at: string | null) =>
  at === null || rows.some((r) => r.kind === 'version');

const asked = (ask: Asks, item: AttentionItem): boolean =>
  'label' in ask &&
  item.labels[ask.label] !== undefined &&
  (ask.value === undefined || item.labels[ask.label] === ask.value);

function question(item: AttentionItem): MapItem {
  const recommended = recommendedChoice(item.message, item.options);
  const option = item.options.find((o) => o.id === recommended);
  return {
    key: `attention-${item.run_id}`,
    number: null,
    title: attentionTitle(item.message) ?? attentionOrigin(item),
    url: consoleUrl(item.console, item.run_id),
    ...(option && { note: `recommends ${option.label ?? option.id}` }),
  };
}

/**
 * The question cards of every view: each counts the open attention items its `asks` names, and the
 * card asking for `rest` the ones no sibling counts and lists every question in its Right now.
 */
function countQuestions(
  factoryMap: FactoryMap,
  live: Map<string, CardLive>,
  sources: MapSources,
): void {
  const { attention, healthRuns, healthSteps, states = {} } = sources;
  const items = parseAttention(attention ?? []);
  for (const level of levelsOf(factoryMap)) {
    const asking = level.cards.filter((card) => card.asks !== undefined);
    for (const card of asking) {
      const entry = live.get(card.id) as CardLive;
      const ask = card.asks as Asks;
      if (states.attention === 'error') entry.unavailable = ['waiting'];
      if ('rest' in ask) {
        if (states.healthRuns === 'error' || states.healthSteps === 'error') {
          entry.healthUnavailable = true;
        } else if (healthRuns !== undefined && healthSteps !== undefined) {
          entry.health = healthItems(sources);
          entry.steps = healthSteps;
        }
      }
      if (attention === undefined || states.attention === 'error') continue;
      const own = items.filter((item) =>
        'rest' in ask
          ? !asking.some((other) => other.asks && asked(other.asks, item))
          : asked(ask, item),
      );
      entry.waiting = own.map(question);
      if ('rest' in ask) entry.questions = items.map(question);
    }
  }
}

const runLink = (console: string | null, run: string) =>
  console === null ? null : consoleUrl(console, run);

/** The health the Manager's Right now lists, by the screen's own definitions (lib/health). */
function healthItems({ healthRuns }: MapSources): MapHealth[] {
  return [
    ...waitingRuns(healthRuns ?? []).map((run) => ({
      key: `health-${run.status}-${run.run_id}`,
      note: `${run.status}: ${run.workflow_name}`,
      run: run.run_id,
      url: runLink(run.console, run.run_id),
    })),
    ...failedLaps(healthRuns ?? []).map((lap) => ({
      key: `health-failed-${lap.run_id}`,
      note: `failed: ${CAUSE_LABEL[lap.cause]}`,
      run: lap.run_id,
      url: runLink(lap.console, lap.run_id),
    })),
  ];
}

/** The steps running far past normal at `now` (ms), by the Health screen's definition. */
export function overdueHealth(steps: readonly HealthStepRow[], now: number): MapHealth[] {
  return overdueSteps(steps, now).map((step) => ({
    key: `health-overdue-${step.run_id}-${step.step_id}`,
    note: `${step.step_id} has run ${formatElapsed(step.running_ms / 1000)}, usually ${formatElapsed(step.p90_ms / 1000)}`,
    run: step.run_id,
    url: runLink(step.console, step.run_id),
  }));
}
