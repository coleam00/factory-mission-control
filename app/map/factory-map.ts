/**
 * The factory map's root view (PRD 4.1): authored by the owner in `factory-map.json`, typed and
 * read here. Its coverage is held to the pinned pack by `bun run map:check` (invariant 6). Pure,
 * no React.
 */
import { type StepRow, stepHref } from '../lib/step-detail';
import data from './factory-map.json';

/** Who is acting on a card, which is its color (docs/design/v2/tokens.css). */
export const ROLES = ['source', 'agent', 'test', 'person'] as const;
export type Role = (typeof ROLES)[number];

export const CHIPS = ['queued', 'failing', 'waiting', 'merged', 'orders'] as const;
export type Chip = (typeof CHIPS)[number];

export const LINE_STYLES = ['flow', 'ask', 'loop'] as const;
export type LineStyle = (typeof LINE_STYLES)[number];

/** The pack a cover entry is held to: the old loop's, or the queue workflows plus the factory package. */
export const PACKS = ['loop', 'queue'] as const;
export type Pack = (typeof PACKS)[number];

/** A step's own screen: the workflow that declares it and its path there. */
export interface Screen {
  workflow: string;
  path: string;
}

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
  /** The screen of an entry an include expanded, which is not a step of `workflow` itself. */
  screens?: Record<string, Screen>;
}

export interface Details {
  when?: string[];
  what?: string[];
  how?: string[];
}

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
  covers: Cover[];
  details: Details;
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

export interface FactoryMap {
  caption: string;
  cardSize: { width: number; height: number };
  cards: Card[];
  group: { x: number; y: number; width: number; height: number; label: string };
  lines: Line[];
  tour: string[];
  legend: { role: Role; label: string }[];
}

export const FACTORY_MAP = data as FactoryMap;

export const cardWidth = (map: FactoryMap, card: Card) => card.width ?? map.cardSize.width;

/** Past the drawing's right and bottom edges: room for the loop line and its arrowheads. */
const WORLD_MARGIN = 12;

/** The world the map is drawn in: every card, the group box and every routed line, with margin. */
export function worldSize(map: FactoryMap): { width: number; height: number } {
  const { height } = map.cardSize;
  const routed = map.lines.flatMap((l) => l.route ?? []);
  return {
    width:
      Math.max(
        ...map.cards.map((c) => c.x + cardWidth(map, c)),
        map.group.x + map.group.width,
        ...routed.map(([x]) => x),
      ) + WORLD_MARGIN,
    height:
      Math.max(
        ...map.cards.map((c) => c.y + height),
        map.group.y + map.group.height,
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

const cardById = (map: FactoryMap, id: string): Card => {
  const card = map.cards.find((c) => c.id === id);
  if (card === undefined) throw new Error(`the factory map has no card ${id}`);
  return card;
};

/**
 * A line's points: its route, or from the right side of its first card to the left side of its
 * second, turning halfway across when they are not level.
 */
export function linePoints(map: FactoryMap, line: Line): Point[] {
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
export function tourPoints(map: FactoryMap): Point[] {
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
export function neighbours(map: FactoryMap, id: string | null): Set<string> {
  const near = new Set<string>();
  if (id === null) return near;
  for (const line of map.lines) {
    if (line.from === id) near.add(line.to);
    if (line.to === id) near.add(line.from);
  }
  return near;
}

/**
 * A step's path from Archon's step id. Archon names a nested step by its path joined with `__`
 * (`ship__deliver__rounds__review`), and a loop group's body step `<group>.<step>` on every
 * iteration (`ship__deliver__rounds.review__policy`, lap-graph.ts), so both separate segments.
 * That is lap-graph's `mapPathOf` while no pinned path holds a dot, which `bun run map:check`
 * holds for every covered workflow of the fixture pack.
 */
export const stepPath = (stepId: string) => stepId.split('__').join('/').replaceAll('.', '/');

const under = (path: string, entry: string) => path === entry || path.startsWith(`${entry}/`);

/**
 * Every card whose deepest covering entry for `workflow`'s step at `path` is the deepest of all:
 * one card for a covered step, none for an uncovered one, two or more when cards share an entry.
 */
export function coveringCards(map: FactoryMap, workflow: string, path: string): Card[] {
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
export const cardForStep = (map: FactoryMap, workflow: string, path: string): Card | undefined =>
  coveringCards(map, workflow, path)[0];

/** A cover entry's screen: its own, or the step itself in the covered workflow. */
export const screenOf = (cover: Cover, step: string): Screen =>
  cover.screens?.[step] ?? { workflow: cover.workflow, path: step };

/** Each step a card covers, opening its step screen at the version pinned `at`. */
export const stepLinks = (card: Card, at: string | null) =>
  card.covers.flatMap((cover) =>
    cover.steps.map((step) => {
      const screen = screenOf(cover, step);
      return { workflow: cover.workflow, step, href: stepHref(screen.workflow, screen.path, at) };
    }),
  );

/** A workflow's own YAML path in the pinned pack, from the parsed architecture; undefined when the version lacks it. */
export const workflowFile = (steps: readonly StepRow[], workflow: string): string | undefined =>
  steps.find((s) => s.workflow === workflow)?.file;

/**
 * The steps of `stepLinks` the pinned version has, by `step-detail`'s rows, each with the model
 * its parsed architecture gives it (null for a step that names none).
 */
export function pinnedStepLinks(card: Card, at: string | null, steps: readonly StepRow[]) {
  const pinned = new Map(steps.map((s) => [`${s.workflow} ${s.path}`, s]));
  // Both packs' screens can resolve to one step (archon-deliver-block rounds/review), so an entry
  // counts only when the pinned version has its workflow.
  return card.covers
    .filter((cover) => steps.some((s) => s.workflow === cover.workflow))
    .flatMap((cover) =>
      cover.steps.flatMap((step) => {
        const screen = screenOf(cover, step);
        const row = pinned.get(`${screen.workflow} ${screen.path}`);
        if (row === undefined) return [];
        return [
          {
            workflow: cover.workflow,
            step,
            model: row.model,
            href: stepHref(screen.workflow, screen.path, at),
          },
        ];
      }),
    );
}
