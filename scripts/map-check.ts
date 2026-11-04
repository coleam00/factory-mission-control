import { join } from 'node:path';
import { LANE_STEPS } from '../app/lib/lap-graph';
import {
  CHIPS,
  coveringCards,
  FACTORY_MAP,
  type FactoryMap,
  LINE_STYLES,
  ROLES,
} from '../app/map/factory-map';
import { type PackVersion, parsePack, type Step } from '../parsers/pack';
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

/** The values the owner's JSON holds outside the closed sets the drawing indexes by. */
function unknownValues(map: FactoryMap): string[] {
  const outside = (what: string, value: string, allowed: readonly string[]) =>
    allowed.includes(value)
      ? []
      : [`${what} ${JSON.stringify(value)} is not one of ${allowed.join(', ')}`];
  return [
    ...map.cards.flatMap((card) => [
      ...outside(`${card.title} role`, card.role, ROLES),
      ...(card.chips ?? []).flatMap((chip) => outside(`${card.title} chip`, chip, CHIPS)),
    ]),
    ...map.lines.flatMap((line) =>
      outside(`line ${line.from} to ${line.to} style`, line.style, LINE_STYLES),
    ),
    ...map.legend.flatMap((entry) => outside(`legend ${entry.label} role`, entry.role, ROLES)),
  ];
}

/**
 * Where the map has drifted from the pack (PRD 4.1, invariant 6), one line each: a card naming a
 * workflow or a step the pack lacks, an entry whose screen is not the step's own, and a step of a
 * covered workflow that no card covers or that two do, or a step a lap's row marks that no card
 * covers.
 */
export function mapCheck(map: FactoryMap, pack: PackVersion): string[] {
  const failures: string[] = unknownValues(map);
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
          if (cover.workflow === 'archon-loop' && step === STEP_THE_PACK_LACKS) continue;
          failures.push(`${card.title} names ${cover.workflow} ${step}, which the pack lacks`);
        }
      }
    }
  }
  // A lane step the pack has goes through the per-step check below; one it lacks needs its own.
  const loopNodes = workflows.get('archon-loop');
  for (const step of LOOP_LANE_STEPS) {
    if (loopNodes?.has(step)) continue;
    const cards = coveringCards(map, 'archon-loop', step);
    if (cards.length === 0) {
      failures.push(`archon-loop ${step} is marked on a lap's row but covered by no card`);
    }
    if (cards.length > 1) {
      failures.push(`archon-loop ${step} is covered by ${cards.map((c) => c.title).join(' and ')}`);
    }
  }
  for (const workflow of covered) {
    for (const path of (workflows.get(workflow) as Map<string, Step>).keys()) {
      if (path.includes('.')) {
        failures.push(`${workflow} ${path} holds a dot, which the home map reads as a loop group`);
      }
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
