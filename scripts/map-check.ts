import { join } from 'node:path';
import { LANE_STEPS } from '../app/lib/lap-graph';
import {
  allCards,
  type Card,
  CHIPS,
  cardChain,
  coveringCards,
  FACTORY_MAP,
  type FactoryMap,
  LINE_STYLES,
  levelsOf,
  type MapView,
  openerOf,
  PACKS,
  type Pack,
  ROLES,
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

type Trees = Record<Pack, Map<string, Map<string, Step>>>;

/** The level above the view `card` sits in; undefined for a root card. */
function parentLevel(map: FactoryMap, card: Card): MapView | undefined {
  const own = levelsOf(map).find((level) => level.cards.includes(card));
  const id = Object.entries(map.views ?? {}).find(([, view]) => view === own)?.[0];
  const opener = id === undefined ? undefined : openerOf(map, id);
  return opener && levelsOf(map).find((level) => level.cards.includes(opener));
}

/** The shape of the views: every `opens` and `upTo` leads somewhere, and every view hangs off the root once. */
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
    if (card.upTo === undefined) continue;
    if (!parentLevel(map, card)?.cards.some((c) => c.id === card.upTo)) {
      failures.push(`${card.title} goes up to ${card.upTo}, which is no card of its parent level`);
    }
  }
  for (const id of views) {
    const openers = cards.filter((c) => c.opens === id);
    if (openers.length === 0) failures.push(`view ${id} is opened by no card`);
    if (openers.length > 1) {
      failures.push(`view ${id} is opened by ${openers.map((c) => c.title).join(' and ')}`);
    }
    if (openers.length === 1 && viewPath(map, id).length === 0) {
      failures.push(`view ${id} cannot be reached from the root`);
    }
  }
  return failures;
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
 * carries only the workflow name, so the pack cannot tell them apart at runtime). A failure naming
 * a pack's step starts with that pack.
 */
export function mapCheck(map: FactoryMap, packs: Record<Pack, PackVersion>): string[] {
  const failures: string[] = [...unknownValues(map), ...viewFailures(map)];
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
