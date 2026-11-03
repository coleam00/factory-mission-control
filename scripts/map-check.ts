import { join } from 'node:path';
import { coveringCards, FACTORY_MAP, type FactoryMap, screenOf } from '../app/map/factory-map';
import { type PackVersion, parsePack, type Step } from '../parsers/pack';
import { failing, type Main, noArguments, runCli } from './lib/cli';

const USAGE = 'usage: bun run map:check';

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

/**
 * Where the map has drifted from the pack (PRD 4.1, invariant 6), one line each: a card naming a
 * workflow or a step the pack lacks, an entry whose screen is not the step's own, and a step of a
 * covered workflow that no card covers or that two do.
 */
export function mapCheck(map: FactoryMap, pack: PackVersion): string[] {
  const failures: string[] = [];
  const workflows = new Map(pack.workflows.map((w) => [w.name, nodesByPath(w.steps)]));
  const covered = new Set<string>();
  for (const card of map.cards) {
    for (const cover of card.covers) {
      const nodes = workflows.get(cover.workflow);
      if (nodes === undefined) {
        failures.push(`${card.title} names workflow ${cover.workflow}, which the pack lacks`);
        continue;
      }
      covered.add(cover.workflow);
      for (const step of cover.steps) {
        if (!nodes.has(step)) {
          failures.push(`${card.title} names ${cover.workflow} ${step}, which the pack lacks`);
          continue;
        }
        const own = ownScreen(cover.workflow, nodes, step);
        const named = screenOf(cover, step);
        if (named.workflow !== own.workflow || named.path !== own.path) {
          failures.push(
            `${card.title} opens ${cover.workflow} ${step} at ${named.workflow} ${named.path}, not its own screen ${own.workflow} ${own.path}`,
          );
        }
      }
    }
  }
  for (const workflow of covered) {
    for (const path of (workflows.get(workflow) as Map<string, Step>).keys()) {
      const cards = coveringCards(map, workflow, path);
      if (cards.length === 0) failures.push(`${workflow} ${path} is covered by no card`);
      if (cards.length > 1) {
        failures.push(
          `${workflow} ${path} is covered by ${cards.map((c) => c.title).join(' and ')}`,
        );
      }
    }
  }
  return failures;
}

export const main: Main = async (argv, deps) =>
  noArguments(argv, USAGE, deps) ??
  failing(deps, async () => {
    const pack = parsePack(
      join(deps.repoRoot, 'fixtures', 'pack', 'sdlc'),
      join(deps.repoRoot, 'fixtures', 'factory-template'),
    );
    const failures = mapCheck(FACTORY_MAP, pack);
    for (const failure of failures) deps.err(failure);
    if (failures.length > 0) {
      throw new Error(
        `map:check: the factory map has drifted from fixtures/pack in ${failures.length} places`,
      );
    }
    deps.out(
      `map:check: every step of ${FACTORY_MAP.cards.length} cards' workflows is covered once`,
    );
  });

if (import.meta.main) await runCli(main);
