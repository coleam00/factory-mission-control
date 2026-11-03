/**
 * The factory map's root view (PRD 4.1): authored by the owner in `factory-map.json`, typed and
 * read here. Its coverage is held to the pinned pack by `bun run map:check` (invariant 6). Pure,
 * no React.
 */
import { stepHref } from '../lib/step-detail';
import data from './factory-map.json';

/** Who is acting on a card, which is its color (docs/design/v2/tokens.css). */
export type Role = 'source' | 'agent' | 'test' | 'person';

export type Chip = 'queued' | 'failing' | 'waiting' | 'merged';

export type LineStyle = 'flow' | 'ask' | 'loop' | 'holdout';

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
  workflow: string;
  steps: string[];
  /** The screen of an entry an include expanded, which is not a step of `workflow` itself. */
  screens?: Record<string, Screen>;
}

export interface Details {
  when?: string[];
  what?: string[];
  how?: string[];
  behind?: { models?: string; source?: string };
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
  minHeight: number;
  cards: Card[];
  group: { x: number; y: number; width: number; height: number; label: string };
  lines: Line[];
  tour: string[];
  legend: { role: Role; label: string }[];
}

export const FACTORY_MAP = data as FactoryMap;

export const cardWidth = (map: FactoryMap, card: Card) => card.width ?? map.cardSize.width;

/** The world the cards are placed in, with the margin the mockup leaves past the last card. */
export function worldSize(map: FactoryMap): { width: number; height: number } {
  const { height } = map.cardSize;
  return {
    width: Math.max(...map.cards.map((c) => c.x + cardWidth(map, c))) + 40,
    height: Math.max(map.minHeight, ...map.cards.map((c) => c.y + height)) + 40,
  };
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

/** Archon names a nested step by its path joined with `__` (`ship__deliver__rounds__review`). */
export const stepPath = (stepId: string) => stepId.split('__').join('/');

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
