/**
 * The factory map's root view (PRD 4.1): authored by the owner in `factory-map.json`, typed and
 * read here. Its coverage is held to the pinned pack by `bun run map:check` (invariant 6). Pure,
 * no React.
 */
import { placeOf, type StepRow, stepHref } from '../lib/step-detail';
import data from './factory-map.json';

/** Who is acting on a card, which is its color (docs/design/v2/tokens.css). */
export const ROLES = ['source', 'agent', 'test', 'person'] as const;
export type Role = (typeof ROLES)[number];

export const CHIPS = ['queued', 'failing', 'waiting', 'merged', 'orders'] as const;
export type Chip = (typeof CHIPS)[number];

/** What a card's Right now lists besides its chips' items: product documents, recent gate outcomes, the latest deploy, where work orders land, the open work orders with their progress (`choices`), the pull requests under check (the App check panel, which subscribes `app-check` itself). */
export const LISTS = ['documents', 'outcomes', 'deploys', 'lands', 'choices', 'checks'] as const;
export type List = (typeof LISTS)[number];

export const LINE_STYLES = ['flow', 'ask', 'loop'] as const;
export type LineStyle = (typeof LINE_STYLES)[number];

/** The pack a cover entry is held to: the old loop's, or the queue workflows plus the factory package. */
export const PACKS = ['loop', 'queue'] as const;
export type Pack = (typeof PACKS)[number];

/**
 * The steps of one workflow a card covers. Each entry covers that step and every step under it;
 * a step under two entries belongs to the deeper one (Build covers the ship include, Review the review
 * rounds inside it).
 */
export interface Cover {
  /** Which pack `bun run map:check` holds this entry to; a live row carries only the workflow name. */
  pack: Pack;
  workflow: string;
  steps: string[];
}

export interface Details {
  when?: string[];
  what?: string[];
  how?: string[];
}

/**
 * The open Archon attention items a question card counts: those carrying the label `label` (with
 * `value` when it names one), or, for `rest`, those no sibling question card counts.
 */
export type LabelAsk = { label: string; value?: string };
export type RestAsk = { rest: true };
export type Asks = LabelAsk | RestAsk;

/** Every key of each `Asks` arm; the compiler fails here when `Asks` and these drift apart. */
export const LABEL_ASK_KEYS: Record<keyof LabelAsk, true> = {
  label: true,
  value: true,
};
export const REST_ASK_KEYS: Record<keyof RestAsk, true> = { rest: true };

export interface Card {
  id: string;
  role: Role;
  /** The kind label, drawn mono and uppercase above the title. */
  kind: string;
  title: string;
  text: string;
  x: number;
  y: number;
  width?: number;
  /** The counts the card shows besides the laps on it (PRD 4.1 "Live"). */
  chips?: Chip[];
  /** What Right now lists for this card besides the items its chips count. */
  lists?: List[];
  covers: Cover[];
  details: Details;
  /** The attention items this card of a question view counts; its `waiting` chip is theirs. */
  asks?: Asks;
  /** The view this card opens (a key of `views`); only a card whose view exists shows ⤢. */
  opens?: string;
  /** A card of the parent level: clicking this card goes up to it (a view's "next" card). */
  upTo?: string;
  /** A card whose laps this card shows as its own: the card is the same step seen from a deeper level. */
  countsAs?: string;
}

export type Point = readonly [number, number];

export interface Line {
  from: string;
  to: string;
  style: LineStyle;
  label?: string;
  /** Absolute points for a line that does not run from one card's side to the next one's. */
  route?: Point[];
  /** False for a line that joins another one, so it ends without an arrowhead. */
  arrow?: boolean;
}

/** One level of the map: the root, or the deeper view a card opens. */
export interface MapView {
  caption: string;
  cardSize: { width: number; height: number };
  cards: Card[];
  /** The dashed box; the root has one, a view may not. */
  group?: { x: number; y: number; width: number; height: number; label: string };
  lines: Line[];
  tour: string[];
}

export interface FactoryMap extends MapView {
  group: NonNullable<MapView['group']>;
  legend: { role: Role; label: string }[];
  /** The deeper views by id; a card's `opens` names one. Card ids are unique across every level. */
  views?: Record<string, MapView>;
}

// JSON infers a route as `number[][]`, which TypeScript will not compare to a `Point[]` when every line of a view routes.
export const FACTORY_MAP = data as unknown as FactoryMap;

export const cardWidth = (map: MapView, card: Card) => card.width ?? map.cardSize.width;

/** Past the drawing's right and bottom edges: room for the loop line and its arrowheads. */
const WORLD_MARGIN = 12;

/** The world the map is drawn in: every card, the group box and every routed line, with margin. */
export function worldSize(map: MapView): { width: number; height: number } {
  const { height } = map.cardSize;
  const routed = map.lines.flatMap((l) => l.route ?? []);
  return {
    width:
      Math.max(
        ...map.cards.map((c) => c.x + cardWidth(map, c)),
        ...(map.group ? [map.group.x + map.group.width] : []),
        ...routed.map(([x]) => x),
      ) + WORLD_MARGIN,
    height:
      Math.max(
        ...map.cards.map((c) => c.y + height),
        ...(map.group ? [map.group.y + map.group.height] : []),
        ...routed.map(([, y]) => y),
      ) + WORLD_MARGIN,
  };
}

/** The fit's margin around the map, in pixels. */
export const FIT_PAD = 16;
/** Room the fit keeps under the map for the hint and the controls. */
export const FIT_FOOT = 48;
/** The frame's least height (owner, PR #326 review). */
export const MIN_FRAME = 420;
/** The largest scale a fit uses. */
export const FIT_MAX = 1.15;

/**
 * The frame's height for a `width` of at least the phone's: the map's height at the scale that
 * fits its width, so a fit leaves no empty bands (owner, PR #326 review, acceptance 10).
 */
export function heroFrameHeight(world: { width: number; height: number }, width: number): number {
  const k = Math.min((width - FIT_PAD * 2) / world.width, FIT_MAX);
  return Math.max(MIN_FRAME, Math.ceil(world.height * k + FIT_PAD * 2 + FIT_FOOT));
}

/** The deeper views whose cards already match their references; the fit of any other view is capped by theirs (issue #485). */
const MATCHING_VIEWS = ['intake', 'review', 'app', 'build', 'build/deliver'];

/** The scale that fits `world` in `frame`, up to `max`, as the Fit control fits it. */
export function fitScale(
  world: { width: number; height: number },
  frame: { width: number; height: number },
  max = FIT_MAX,
): number {
  return Math.min(
    (frame.width - FIT_PAD * 2) / world.width,
    (frame.height - FIT_PAD * 2 - FIT_FOOT) / world.height,
    max,
  );
}

/**
 * The largest scale `level` is fitted at in `frame`: FIT_MAX for the root; for a deeper view, the
 * largest scale the matching views fit at in the same frame, so a view with few cards is not drawn
 * larger than the reference (issue #485). The matching views keep their own fit by construction.
 */
export function levelMax(
  map: FactoryMap,
  level: MapView,
  frame: { width: number; height: number },
): number {
  if (level === map) return FIT_MAX;
  const fits = MATCHING_VIEWS.map((id) => fitScale(worldSize(map.views?.[id] as MapView), frame));
  return Math.max(...fits);
}

const cardById = (map: MapView, id: string): Card => {
  const card = map.cards.find((c) => c.id === id);
  if (card === undefined) throw new Error(`the factory map has no card ${id}`);
  return card;
};

/**
 * A line's points: its route, or from the right side of its first card to the left side of its
 * second, turning halfway across when they are not level.
 */
export function linePoints(map: MapView, line: Line): Point[] {
  if (line.route) return line.route;
  const a = cardById(map, line.from);
  const b = cardById(map, line.to);
  const half = map.cardSize.height / 2;
  const start: Point = [a.x + cardWidth(map, a), a.y + half];
  const end: Point = [b.x, b.y + half];
  if (start[1] === end[1]) return [start, end];
  const mid = (start[0] + end[0]) / 2;
  return [start, [mid, start[1]], [mid, end[1]], end];
}

export const pathOf = (points: readonly Point[]) =>
  points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x},${y}`).join(' ');

/** The point halfway along a polyline, where its label sits. */
export function midpoint(points: readonly Point[]): Point {
  const lengths = points.slice(1).map(([x, y], i) => {
    const [px, py] = points[i] as Point;
    return Math.hypot(x - px, y - py);
  });
  let left = lengths.reduce((n, l) => n + l, 0) / 2;
  for (const [i, length] of lengths.entries()) {
    const [x0, y0] = points[i] as Point;
    const [x1, y1] = points[i + 1] as Point;
    if (left <= length && length > 0) {
      const t = left / length;
      return [x0 + (x1 - x0) * t, y0 + (y1 - y0) * t];
    }
    left -= length;
  }
  return points[points.length - 1] as Point;
}

/** The tour the dot travels: card centre to card centre, level first, then across. */
export function tourPoints(map: MapView): Point[] {
  const centres = map.tour.map((id): Point => {
    const card = cardById(map, id);
    return [card.x + cardWidth(map, card) / 2, card.y + map.cardSize.height / 2];
  });
  const points: Point[] = centres.slice(0, 1);
  for (const [i, next] of centres.slice(1).entries()) {
    const prev = centres[i] as Point;
    if (prev[1] !== next[1]) {
      const mid = (prev[0] + next[0]) / 2;
      points.push([mid, prev[1]], [mid, next[1]]);
    }
    points.push(next);
  }
  return points;
}

/** The cards a line joins directly to `id`; none for no selection. */
export function neighbours(map: MapView, id: string | null): Set<string> {
  const near = new Set<string>();
  if (id === null) return near;
  for (const line of map.lines) {
    if (line.from === id) near.add(line.to);
    if (line.to === id) near.add(line.from);
  }
  return near;
}

const under = (path: string, entry: string) => path === entry || path.startsWith(`${entry}/`);

/**
 * Every card whose deepest covering entry for `workflow`'s step at `path` is the deepest of all:
 * one card for a covered step, none for an uncovered one, two or more when cards share an entry.
 */
export function coveringCards(map: MapView, workflow: string, path: string): Card[] {
  let depth = -1;
  let cards: Card[] = [];
  for (const card of map.cards) {
    for (const cover of card.covers) {
      if (cover.workflow !== workflow) continue;
      for (const entry of cover.steps) {
        if (!under(path, entry)) continue;
        const d = entry.split('/').length;
        if (d > depth) {
          depth = d;
          cards = [card];
        } else if (d === depth && !cards.includes(card)) {
          cards.push(card);
        }
      }
    }
  }
  return cards;
}

/** The card a running step counts on, or undefined for a step no card covers. */
export const cardForStep = (map: MapView, workflow: string, path: string): Card | undefined =>
  coveringCards(map, workflow, path)[0];

/** The level a path of view ids names: the root for `[]`, and for an id the map lacks. */
export const levelOf = (map: FactoryMap, path: readonly string[]): MapView =>
  map.views?.[path.at(-1) ?? ''] ?? map;

/** The root, then every deeper view. */
export const levelsOf = (map: FactoryMap): MapView[] => [map, ...Object.values(map.views ?? {})];

/** Every card of the map, at every level. */
export const allCards = (map: FactoryMap): Card[] => levelsOf(map).flatMap((level) => level.cards);

/**
 * The card whose `opens` names `viewId`: the first in document order, which is the one the view
 * hangs off. A view may also be opened from a card deeper in the map (the Deliver view's Review
 * card opens the Review view); `inLevel` picks that card.
 */
export const openerOf = (map: FactoryMap, viewId: string, inLevel?: MapView): Card | undefined =>
  (inLevel?.cards ?? allCards(map)).find((card) => card.opens === viewId);

/**
 * The view ids from the root down to the view `id` names, through the card that opens each; the
 * root's `[]` for no id, an unknown one, or a chain that never reaches the root. `from` names the
 * view the viewer opened `id` from when a card there opens it too: the path then runs through it.
 */
export function viewPath(map: FactoryMap, id: string | null, from?: string | null): string[] {
  const path: string[] = [];
  let at = id;
  for (let hops = 0; at && hops <= Object.keys(map.views ?? {}).length; hops++) {
    if (map.views?.[at] === undefined) return [];
    path.unshift(at);
    const via = hops === 0 && from ? map.views[from] : undefined;
    const opener = openerOf(map, at, via);
    if (opener === undefined) return hops === 0 && via !== undefined ? viewPath(map, id) : [];
    const parent = Object.entries(map.views).find(([, v]) => v.cards.includes(opener))?.[0];
    if (parent === undefined) return path;
    at = parent;
  }
  return [];
}

/** The address parameter that names the open view. */
export const VIEW_PARAM = 'view';

/** The address parameter naming the view a shared view was opened from. */
export const FROM_PARAM = 'from';

/**
 * `prev` with `view` set to the deepest view of `path`, or removed for the root. A view reached
 * other than through its first opener also records the view above it in `from`.
 */
export function viewSearch(
  map: FactoryMap,
  prev: URLSearchParams,
  path: readonly string[],
): URLSearchParams {
  const next = new URLSearchParams(prev);
  next.delete(FROM_PARAM);
  const view = path.at(-1);
  if (view === undefined) {
    next.delete(VIEW_PARAM);
    return next;
  }
  next.set(VIEW_PARAM, view);
  const above = path.at(-2);
  if (above !== undefined && viewPath(map, view).at(-2) !== above) next.set(FROM_PARAM, above);
  return next;
}

/**
 * The cards a step counts on, one per level: its card at the root, then its card in that card's
 * view, and so on. A view's card covers a step only inside the card that opens the view.
 */
export function cardChain(map: FactoryMap, workflow: string, path: string): Card[] {
  const chain: Card[] = [];
  let level: MapView = map;
  for (;;) {
    const card = cardForStep(level, workflow, path);
    if (card === undefined) return chain;
    chain.push(card);
    const next = card.opens === undefined ? undefined : map.views?.[card.opens];
    if (next === undefined) return chain;
    level = next;
  }
}

/**
 * Every card a step's laps show on: its `cardChain`, plus each card that counts as one of those.
 * Coverage uses `cardChain` alone, since an alias covers nothing.
 */
export function cardsCounting(map: FactoryMap, workflow: string, path: string): Card[] {
  const chain = cardChain(map, workflow, path);
  const ids = new Set(chain.map((card) => card.id));
  const aliases = allCards(map).filter((card) => card.countsAs && ids.has(card.countsAs));
  return [...chain, ...aliases];
}

/** Each step a card covers, opening its place in the covered workflow at the version pinned `at`. */

export const stepLinks = (card: Card, at: string | null) =>
  card.covers.flatMap((cover) =>
    cover.steps.map((step) => ({
      workflow: cover.workflow,
      step,
      href: stepHref(cover.workflow, step, at),
    })),
  );

/** A workflow's own YAML path in the pinned pack, from the parsed architecture; undefined when the version lacks it. */
export const workflowFile = (steps: readonly StepRow[], workflow: string): string | undefined =>
  steps.find((s) => s.workflow === workflow)?.file;

/**
 * The steps of `stepLinks` the pinned version has, by `step-detail`'s rows, each with the model
 * its parsed architecture gives it (null for a step that names none).
 */
export function pinnedStepLinks(card: Card, at: string | null, steps: readonly StepRow[]) {
  // Both packs' places can resolve to one step (archon-deliver-block rounds/review), so an entry
  // counts only when the pinned version has its workflow.
  return card.covers
    .filter((cover) => steps.some((s) => s.workflow === cover.workflow))
    .flatMap((cover) =>
      cover.steps.flatMap((step) => {
        const row = placeOf(steps, cover.workflow, step)?.step;
        if (row === undefined) return [];
        return [
          {
            workflow: cover.workflow,
            step,
            model: row.model,
            href: stepHref(cover.workflow, step, at),
          },
        ];
      }),
    );
}
