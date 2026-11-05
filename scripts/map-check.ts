import { join } from 'node:path';
import { LANE_STEPS } from '../app/lib/lap-graph';
import {
  allCards,
  type Card,
  CHIPS,
  type Cover,
  cardChain,
  cardWidth,
  coveringCards,
  type Details,
  FACTORY_MAP,
  type FactoryMap,
  LABEL_ASK_KEYS,
  LINE_STYLES,
  LISTS,
  type Line,
  levelsOf,
  linePoints,
  type MapView,
  openerOf,
  PACKS,
  type Pack,
  type Point,
  REST_ASK_KEYS,
  ROLES,
  type Screen,
  screenOf,
  viewPath,
} from '../app/map/factory-map';
import { type PackVersion, parsePack, parseVersion, type Step } from '../parsers/pack';
import { failing, type Main, noArguments, runCli } from './lib/cli';

const USAGE = 'usage: bun run map:check';

/** The loop steps a lap's row marks and its header counts; a running lap on one counts on a card. */
const LOOP_LANE_STEPS = LANE_STEPS.flatMap((step) => step.split('/'));

/** The one lane step the running loop has that the pack's copy of it lacks. */
const STEP_THE_PACK_LACKS = 'handoff';

/** Every node of a workflow's expanded tree, at every depth, by its path. */
function nodesByPath(steps: readonly Step[], into = new Map<string, Step>()): Map<string, Step> {
  for (const step of steps) {
    into.set(step.path, step);
    nodesByPath(step.steps, into);
  }
  return into;
}

/**
 * Where a node's own screen is: under the workflow that declares it, at its path below the include
 * that expanded it there, as the home map's step links have always opened it.
 */
function ownScreen(workflow: string, nodes: ReadonlyMap<string, Step>, path: string) {
  const node = nodes.get(path) as Step;
  if (node.definedIn === workflow) return { workflow, path };
  const parts = path.split('/');
  for (let depth = parts.length - 1; depth > 0; depth--) {
    const include = parts.slice(0, depth).join('/');
    if (nodes.get(include)?.include === node.definedIn) {
      return { workflow: node.definedIn, path: parts.slice(depth).join('/') };
    }
  }
  return { workflow: node.definedIn, path };
}

/** The values the owner's JSON holds outside the closed sets the drawing indexes by. */
function unknownValues(map: FactoryMap): string[] {
  const outside = (what: string, value: string, allowed: readonly string[]) =>
    allowed.includes(value)
      ? []
      : [`${what} ${JSON.stringify(value)} is not one of ${allowed.join(', ')}`];
  return [
    ...allCards(map).flatMap((card) => [
      ...outside(`${card.title} role`, card.role, ROLES),
      ...(card.chips ?? []).flatMap((chip) => outside(`${card.title} chip`, chip, CHIPS)),
      ...(card.lists ?? []).flatMap((list) => outside(`${card.title} list`, list, LISTS)),
    ]),
    ...levelsOf(map)
      .flatMap((level) => level.lines)
      .flatMap((line) => outside(`line ${line.from} to ${line.to} style`, line.style, LINE_STYLES)),
    ...map.legend.flatMap((entry) => outside(`legend ${entry.label} role`, entry.role, ROLES)),
    ...allCards(map).flatMap((card) =>
      card.covers.flatMap((cover) =>
        outside(`${card.title} cover ${cover.workflow} pack`, cover.pack, PACKS),
      ),
    ),
  ];
}

/** Every object nested anywhere in a parsed workflow document. */
function objectsIn(value: unknown): Record<string, unknown>[] {
  if (typeof value !== 'object' || value === null) return [];
  const children = Object.values(value).flatMap(objectsIn);
  return Array.isArray(value) ? children : [value as Record<string, unknown>, ...children];
}

/**
 * The attention labels the pack's waits declare, which a question card's `asks` may name, each with
 * the values it can take: the literal a wait sets, the literals every include of its workflow passes
 * for an `$INPUTS` label, or `undefined` when a run's output feeds it and any value may appear.
 */
function attentionLabels(pack: PackVersion): Map<string, Set<string> | undefined> {
  const docs = pack.workflows.map((workflow) => ({
    name: workflow.name,
    doc: Bun.YAML.parse(workflow.yaml) as {
      nodes?: { wait?: { labels?: Record<string, unknown> } }[];
    },
  }));
  const labels = new Map<string, Set<string> | undefined>();
  for (const { name, doc } of docs) {
    for (const node of doc.nodes ?? []) {
      for (const [key, source] of Object.entries(node.wait?.labels ?? {})) {
        const known = labels.has(key) ? labels.get(key) : new Set<string>();
        const input =
          typeof source === 'string' ? /^\$INPUTS\.(\w+)$/.exec(source)?.[1] : undefined;
        if (known === undefined) continue;
        if (typeof source !== 'string' || (input === undefined && source.includes('$'))) {
          labels.set(key, undefined);
          continue;
        }
        if (input === undefined) known.add(source);
        else {
          const passed = docs
            .flatMap((other) => objectsIn(other.doc))
            .filter((object) => object.include === name)
            .map((object) => (object.with as Record<string, unknown> | undefined)?.[input]);
          if (passed.some((value) => typeof value !== 'string' || value.includes('$'))) {
            labels.set(key, undefined);
            continue;
          }
          for (const value of passed) known.add(value as string);
        }
        labels.set(key, known);
      }
    }
  }
  return labels;
}

/** A question card's `asks` is a label of the queue pack (with an optional value), or `rest`, once a level. */
function askFailures(
  map: FactoryMap,
  labels: ReadonlyMap<string, ReadonlySet<string> | undefined>,
): string[] {
  return levelsOf(map).flatMap((level) => {
    const asks = level.cards.flatMap((card) => (card.asks === undefined ? [] : [card]));
    const rests = asks.filter((card) => 'rest' in (card.asks as object));
    return [
      ...asks.flatMap((card) => {
        const ask = card.asks as Partial<
          Record<keyof typeof LABEL_ASK_KEYS | keyof typeof REST_ASK_KEYS, unknown>
        >;
        const at = `${card.title} asks`;
        if ('rest' in ask) {
          return ask.rest === true &&
            Object.keys(ask).every((key) => Object.hasOwn(REST_ASK_KEYS, key))
            ? []
            : [`${at} ${JSON.stringify(ask)}, not exactly {"rest": true}`];
        }
        if (typeof ask.label !== 'string' || ask.label === '') {
          return [`${at} ${JSON.stringify(ask)}, which names no label`];
        }
        const unknown = Object.keys(ask).filter((key) => !Object.hasOwn(LABEL_ASK_KEYS, key));
        if (unknown.length > 0) {
          return [`${at} ${JSON.stringify(ask)}, with unknown key ${unknown.join(', ')}`];
        }
        if (ask.value !== undefined && typeof ask.value !== 'string') {
          return [`${at} label ${ask.label} with a value that is not a string`];
        }
        if (!labels.has(ask.label)) {
          return [
            `${at} label ${JSON.stringify(ask.label)}, which no wait of the queue pack declares`,
          ];
        }
        const values = labels.get(ask.label);
        return ask.value === undefined || values === undefined || values.has(ask.value)
          ? []
          : [
              `${at} label ${ask.label} with value ${JSON.stringify(ask.value)}, which the queue pack never sets (${[...values].join(', ')})`,
            ];
      }),
      ...(rests.length > 1
        ? [`${rests.map((card) => card.title).join(' and ')} all ask for the rest`]
        : []),
    ];
  });
}

/**
 * The keys the map reads from each kind of object in `factory-map.json`. Each list names every key
 * of its interface, so the compiler fails when the two drift apart.
 */
const ROOT_KEYS: Record<keyof FactoryMap, true> = {
  caption: true,
  cardSize: true,
  cards: true,
  group: true,
  lines: true,
  tour: true,
  legend: true,
  views: true,
};
const VIEW_KEYS: Record<keyof MapView, true> = {
  caption: true,
  cardSize: true,
  cards: true,
  group: true,
  lines: true,
  tour: true,
};
const SIZE_KEYS: Record<keyof MapView['cardSize'], true> = { width: true, height: true };
const GROUP_KEYS: Record<keyof NonNullable<MapView['group']>, true> = {
  x: true,
  y: true,
  width: true,
  height: true,
  label: true,
};
const LEGEND_KEYS: Record<keyof FactoryMap['legend'][number], true> = { role: true, label: true };
const CARD_KEYS: Record<keyof Card, true> = {
  id: true,
  role: true,
  kind: true,
  title: true,
  text: true,
  x: true,
  y: true,
  width: true,
  chips: true,
  lists: true,
  covers: true,
  details: true,
  opens: true,
  upTo: true,
  countsAs: true,
  asks: true,
};
const COVER_KEYS: Record<keyof Cover, true> = {
  pack: true,
  workflow: true,
  steps: true,
  screens: true,
};
const SCREEN_KEYS: Record<keyof Screen, true> = { workflow: true, path: true };
const DETAILS_KEYS: Record<keyof Details, true> = { when: true, what: true, how: true };
const LINE_KEYS: Record<keyof Line, true> = {
  from: true,
  to: true,
  style: true,
  label: true,
  route: true,
  arrow: true,
};

/** The keys of the owner's JSON the map's types do not declare: the map would drop them silently. */
function unknownKeys(map: FactoryMap): string[] {
  const extra = (what: string, value: object, keys: object) =>
    Object.keys(value)
      .filter((key) => !Object.hasOwn(keys, key))
      .map((key) => `${what} has key ${JSON.stringify(key)}, which the map does not read`);
  const views = Object.entries(map.views ?? {});
  const levels: [string, MapView][] = [
    ['the map', map],
    ...views.map(([id, view]): [string, MapView] => [`view ${id}`, view]),
  ];
  return [
    ...extra('the map', map, ROOT_KEYS),
    ...views.flatMap(([id, view]) => extra(`view ${id}`, view, VIEW_KEYS)),
    ...map.legend.flatMap((entry) => extra(`legend ${entry.label}`, entry, LEGEND_KEYS)),
    ...levels.flatMap(([name, level]) => [
      ...extra(`${name} cardSize`, level.cardSize, SIZE_KEYS),
      ...(level.group ? extra(`${name} group`, level.group, GROUP_KEYS) : []),
      ...level.lines.flatMap((line) => extra(`line ${line.from} to ${line.to}`, line, LINE_KEYS)),
      ...level.cards.flatMap((card) => [
        ...extra(card.title, card, CARD_KEYS),
        ...extra(`${card.title} details`, card.details, DETAILS_KEYS),
        ...card.covers.flatMap((cover) => [
          ...extra(`${card.title} cover ${cover.workflow}`, cover, COVER_KEYS),
          ...Object.entries(cover.screens ?? {}).flatMap(([step, screen]) =>
            extra(`${card.title} cover ${cover.workflow} screen ${step}`, screen, SCREEN_KEYS),
          ),
        ]),
      ]),
    ]),
  ];
}

type Trees = Record<Pack, Map<string, Map<string, Step>>>;

/** The level above the view `card` sits in; undefined for a root card. */
function parentLevel(map: FactoryMap, card: Card): MapView | undefined {
  const own = levelsOf(map).find((level) => level.cards.includes(card));
  const id = Object.entries(map.views ?? {}).find(([, view]) => view === own)?.[0];
  const opener = id === undefined ? undefined : openerOf(map, id);
  return opener && levelsOf(map).find((level) => level.cards.includes(opener));
}

/**
 * The shape of the views: every `opens` and `upTo` leads somewhere, and every view hangs off the
 * root once (a card deeper in the map may open it again, one per level). A `countsAs` names a card
 * that counts as nothing else, and its card covers no step of its own, so `cardsCounting` counts
 * each lap once.
 */
function viewFailures(map: FactoryMap): string[] {
  const failures: string[] = [];
  const views = Object.keys(map.views ?? {});
  const cards = allCards(map);
  for (const id of new Set(cards.map((c) => c.id))) {
    if (cards.filter((c) => c.id === id).length > 1) failures.push(`card id ${id} is used twice`);
  }
  for (const card of cards) {
    if (card.opens !== undefined && !views.includes(card.opens)) {
      failures.push(`${card.title} opens view ${card.opens}, which the map lacks`);
    }
    if (card.countsAs !== undefined) {
      const target = cards.find((c) => c.id === card.countsAs);
      if (target === undefined) {
        failures.push(`${card.title} counts as ${card.countsAs}, which is no card`);
      } else if (target === card) {
        failures.push(`${card.title} counts as itself`);
      } else if (target.countsAs !== undefined) {
        failures.push(
          `${card.title} counts as ${card.countsAs}, which counts as ${target.countsAs}`,
        );
      }
      if (card.covers.length > 0) {
        failures.push(`${card.title} counts as ${card.countsAs} but covers steps of its own`);
      }
    }
    if (card.upTo === undefined) continue;
    if (!parentLevel(map, card)?.cards.some((c) => c.id === card.upTo)) {
      failures.push(`${card.title} goes up to ${card.upTo}, which is no card of its parent level`);
    }
  }
  for (const id of views) {
    const openers = cards.filter((c) => c.opens === id);
    if (openers.length === 0) failures.push(`view ${id} is opened by no card`);
    const sameLevel = levelsOf(map)
      .map((level) => openers.filter((c) => level.cards.includes(c)))
      .find((inLevel) => inLevel.length > 1);
    if (sameLevel !== undefined) {
      failures.push(`view ${id} is opened by ${sameLevel.map((c) => c.title).join(' and ')}`);
    }
    if (openers.length > 0 && viewPath(map, id).length === 0) {
      failures.push(`view ${id} cannot be reached from the root`);
    }
  }
  return failures;
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

const onBox = (box: Box, [x, y]: Point) =>
  x >= box.x &&
  x <= box.x + box.width &&
  y >= box.y &&
  y <= box.y + box.height &&
  (x === box.x || x === box.x + box.width || y === box.y || y === box.y + box.height);

const inside = (outer: Box, inner: Box) =>
  inner.x >= outer.x &&
  inner.y >= outer.y &&
  inner.x + inner.width <= outer.x + outer.width &&
  inner.y + inner.height <= outer.y + outer.height;

/** Whether `point` lies on a segment of the orthogonal `points`. */
function onPolyline(points: readonly Point[], [x, y]: Point): boolean {
  return points.slice(1).some(([bx, by], i) => {
    const [ax, ay] = points[i] as Point;
    const collinear = (bx - ax) * (y - ay) === (by - ay) * (x - ax);
    const inBox = x >= Math.min(ax, bx) && x <= Math.max(ax, bx);
    return collinear && inBox && y >= Math.min(ay, by) && y <= Math.max(ay, by);
  });
}

/**
 * Whether each routed line starts on an edge of its `from` card and ends on an edge of its `to`
 * card, so moving a card or resizing the cards without the route detaches it. A route may also end
 * on the dashed group's edge when its `to` card sits inside the group, and an arrowless line, which
 * joins another, may end on a line into the same card.
 */
function routeFailures(map: FactoryMap): string[] {
  return levelsOf(map).flatMap((level) =>
    level.lines.flatMap((line) => {
      const from = level.cards.find((c) => c.id === line.from);
      const to = level.cards.find((c) => c.id === line.to);
      if (!line.route || from === undefined || to === undefined) return [];
      const box = (card: Card): Box => ({
        x: card.x,
        y: card.y,
        width: cardWidth(level, card),
        height: level.cardSize.height,
      });
      const first = line.route[0] as Point;
      const last = line.route[line.route.length - 1] as Point;
      const joins = level.lines
        .filter((other) => other !== line && other.to === line.to)
        .map((other) => linePoints(level, other));
      const endsOn =
        onBox(box(to), last) ||
        (level.group !== undefined && inside(level.group, box(to)) && onBox(level.group, last)) ||
        (line.arrow === false && joins.some((points) => onPolyline(points, last)));
      const name = `line ${line.from} to ${line.to}`;
      return [
        ...(onBox(box(from), first)
          ? []
          : [`${name} starts at ${first.join(',')}, off ${line.from}`]),
        ...(endsOn ? [] : [`${name} ends at ${last.join(',')}, off ${line.to}`]),
      ];
    }),
  );
}

/**
 * For each view, the steps of the card that opens it are covered by exactly one card of the view,
 * and no card of the view covers a step, or a workflow, the opening card does not. A view clips to
 * its opener: a step another card of the level above claims (`cardChain`) is not the opener's.
 */
function viewPartition(map: FactoryMap, trees: Trees): string[] {
  const failures: string[] = [];
  const cards = allCards(map);
  for (const [id, view] of Object.entries(map.views ?? {})) {
    const path = viewPath(map, id);
    const opener = cards.find((c) => c.opens === id);
    if (path.length === 0 || opener === undefined) continue;
    const depth = path.length - 1;
    const inOpener = new Map<string, Set<string>>();
    for (const cover of opener.covers) {
      const nodes = trees[cover.pack].get(cover.workflow);
      if (nodes === undefined) continue;
      const mine = new Set(
        [...nodes.keys()].filter(
          (node) => cardChain(map, cover.workflow, node)[depth]?.id === opener.id,
        ),
      );
      for (const step of cover.steps) if (!nodes.has(step)) mine.add(step);
      inOpener.set(`${cover.pack} ${cover.workflow}`, mine);
      for (const node of mine) {
        const covering = coveringCards(view, cover.workflow, node);
        const at = `${cover.pack} pack: ${opener.title} view: ${cover.workflow} ${node}`;
        if (covering.length === 0) failures.push(`${at} is covered by no card`);
        if (covering.length > 1) {
          failures.push(`${at} is covered by ${covering.map((c) => c.title).join(' and ')}`);
        }
      }
    }
    for (const card of view.cards) {
      for (const cover of card.covers) {
        const at = `${cover.pack} pack: ${opener.title} view: ${card.title}`;
        const mine = inOpener.get(`${cover.pack} ${cover.workflow}`);
        if (mine === undefined) {
          failures.push(
            `${at} names workflow ${cover.workflow}, which ${opener.title} does not cover`,
          );
          continue;
        }
        for (const step of cover.steps) {
          const known =
            trees[cover.pack].get(cover.workflow)?.has(step) || step === STEP_THE_PACK_LACKS;
          if (known && !mine.has(step)) {
            failures.push(`${at} covers ${cover.workflow} ${step}, which ${opener.title} does not`);
          }
        }
      }
    }
  }
  return failures;
}

/**
 * Where the map has drifted from the packs (PRD 4.1, invariant 6), one line each: a card naming a
 * workflow or a step its pack lacks, an entry whose screen is not the step's own, a step of a
 * covered workflow that no card covers or that two do, a step a lap's row marks that no card
 * covers, and a step of a pack that counts on a card only through another pack's entry (a live row
 * carries only the workflow name, so the pack cannot tell them apart at runtime). Also a key the
 * map's types do not declare, a `countsAs` that would make a lap count twice or not at all, and a
 * routed line off its cards. A failure naming a pack's step starts with that pack.
 */
export function mapCheck(map: FactoryMap, packs: Record<Pack, PackVersion>): string[] {
  const failures: string[] = [
    ...unknownKeys(map),
    ...unknownValues(map),
    ...askFailures(map, attentionLabels(packs.queue)),
    ...viewFailures(map),
    ...routeFailures(map),
  ];
  const trees = Object.fromEntries(
    PACKS.map((pack) => [
      pack,
      new Map(packs[pack].workflows.map((w) => [w.name, nodesByPath(w.steps)])),
    ]),
  ) as Trees;
  const covered: Record<Pack, Set<string>> = { loop: new Set(), queue: new Set() };
  for (const card of allCards(map)) {
    for (const cover of card.covers) {
      const at = `${cover.pack} pack: ${card.title}`;
      if (!PACKS.includes(cover.pack)) continue;
      const nodes = trees[cover.pack].get(cover.workflow);
      if (nodes === undefined) {
        failures.push(`${at} names workflow ${cover.workflow}, which the pack lacks`);
        continue;
      }
      if (map.cards.includes(card)) covered[cover.pack].add(cover.workflow);
      for (const step of cover.steps) {
        if (!nodes.has(step)) {
          if (
            cover.pack === 'loop' &&
            cover.workflow === 'archon-loop' &&
            step === STEP_THE_PACK_LACKS
          ) {
            continue;
          }
          failures.push(`${at} names ${cover.workflow} ${step}, which the pack lacks`);
          continue;
        }
        const own = ownScreen(cover.workflow, nodes, step);
        const named = screenOf(cover, step);
        if (named.workflow !== own.workflow || named.path !== own.path) {
          failures.push(
            `${at} opens ${cover.workflow} ${step} at ${named.workflow} ${named.path}, not its own screen ${own.workflow} ${own.path}`,
          );
        }
      }
    }
  }
  // A lane step the pack has goes through the per-step check below; one it lacks needs its own.
  const loopNodes = trees.loop.get('archon-loop');
  for (const step of LOOP_LANE_STEPS) {
    if (loopNodes?.has(step)) continue;
    const cards = coveringCards(map, 'archon-loop', step);
    if (cards.length === 0) {
      failures.push(
        `loop pack: archon-loop ${step} is marked on a lap's row but covered by no card`,
      );
    }
    if (cards.length > 1) {
      failures.push(
        `loop pack: archon-loop ${step} is covered by ${cards.map((c) => c.title).join(' and ')}`,
      );
    }
  }
  for (const pack of PACKS) {
    for (const [workflow, nodes] of trees[pack]) {
      for (const path of nodes.keys()) {
        const cards = coveringCards(map, workflow, path);
        const names = cards.map((c) => c.title).join(' and ');
        if (!covered[pack].has(workflow)) {
          if (cards.length > 0) {
            failures.push(
              `${pack} pack: ${workflow} ${path}, which no ${pack} card covers, counts on ${names}`,
            );
          }
          continue;
        }
        if (path.includes('.')) {
          failures.push(
            `${pack} pack: ${workflow} ${path} holds a dot, which the home map reads as a loop group`,
          );
        }
        if (cards.length === 0)
          failures.push(`${pack} pack: ${workflow} ${path} is covered by no card`);
        if (cards.length > 1)
          failures.push(`${pack} pack: ${workflow} ${path} is covered by ${names}`);
      }
    }
  }
  return [...failures, ...viewPartition(map, trees)];
}

/** The queue pack and the factory package, as one pack: Archon's `sdlc` workflows and the factory's own. */
export function parseQueuePack(root: string, templateDir: string): PackVersion {
  return parseVersion(join(root, 'sdlc'), join(root, 'factory'), templateDir);
}

export const main: Main = async (argv, deps) =>
  noArguments(argv, USAGE, deps) ??
  failing(deps, async () => {
    const template = join(deps.repoRoot, 'fixtures', 'factory-template');
    const queueRoot = join(deps.repoRoot, 'fixtures', 'pack', 'queue');
    const packs = {
      loop: parsePack(join(deps.repoRoot, 'fixtures', 'pack', 'sdlc'), template),
      queue: parseQueuePack(queueRoot, template),
    };
    const failures = mapCheck(FACTORY_MAP, packs);
    for (const failure of failures) deps.err(failure);
    if (failures.length > 0) {
      throw new Error(
        `map:check: the factory map has drifted from the packs in ${failures.length} places`,
      );
    }
    deps.out(
      `map:check: every step of ${FACTORY_MAP.cards.length} cards' workflows is covered once, and each of ${Object.keys(FACTORY_MAP.views ?? {}).length} views covers its card's steps once`,
    );
  });

if (import.meta.main) await runCli(main);
