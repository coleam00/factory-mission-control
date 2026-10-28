import { expect, test } from 'bun:test';
import {
  freePort,
  LIMITS,
  lateWrite,
  mapMismatches,
  SEED_INCLUDE_STAGES,
  type ShownNode,
} from './shared';

test('freePort waits while every port in 8850-8864 is taken and takes the first one freed', async () => {
  const lines: string[] = [];
  let clock = 0;
  const deps = {
    now: () => new Date(clock),
    sleep: async (ms: number) => {
      clock += ms;
    },
    out: (line: string) => lines.push(line),
  };
  const port = await freePort(deps, { pollMs: 1000, free: (p) => p === 8857 && clock >= 3000 });
  expect(port).toBe(8857);
  expect(lines).toEqual([
    'every port in 8850-8864 is taken: waiting for one (up to 30 min)',
    'port 8857 is free',
  ]);
});

test('freePort gives up once its wait runs out', async () => {
  let clock = 0;
  const deps = {
    now: () => new Date(clock),
    sleep: async (ms: number) => {
      clock += ms;
    },
    out: () => {},
  };
  await expect(freePort(deps, { waitMs: 120_000, free: () => false })).rejects.toThrow(
    'no free port in 8850-8864 after 2 min',
  );
});

test('a missing or late write names its reading and its value', () => {
  const limit = LIMITS.insertToScreenMs;
  expect(lateWrite('the pin before the hold (pinToScreenMs)', 'the versions screen', null)).toEqual(
    [
      `the pin before the hold (pinToScreenMs) never reached the versions screen within ${limit} ms`,
    ],
  );
  expect(lateWrite('label first', 'the issues screen', undefined)).toEqual([
    `label first never reached the issues screen within ${limit} ms`,
  ]);
  expect(lateWrite('a pin', 'the versions screen', limit + 1)).toEqual([
    `a pin reached the versions screen after ${limit + 1} ms, limit ${limit}`,
  ]);
  expect(lateWrite('a pin', 'the versions screen', limit)).toEqual([]);
});

/** The seed's loop as the map shows it: top-level steps, then each include's direct stages. */
function seedMap(stages: Record<string, readonly string[]> = SEED_INCLUDE_STAGES): ShownNode[] {
  const top = [
    'pick',
    'claim',
    'build',
    'ship',
    'subject',
    'check-app',
    'evidence',
    'review',
    'land',
    'deploy',
    'release',
    'tally',
  ];
  const node = (role: string, step: string): ShownNode => ({
    role,
    workflow: 'archon-loop',
    step,
    count: null,
  });
  return [
    ...top.flatMap((t) => [
      node('step', t),
      ...(stages[t] ?? []).map((s) => node('stage', `${t}/${s}`)),
    ]),
    // A deeper stage is not a direct stage of its include.
    node('stage', 'ship/deliver/forge'),
  ];
}
const stageLines = (nodes: ShownNode[]) =>
  mapMismatches(nodes, () => 0).filter((f) => /^\w+ shows (?!\d)/.test(f) && !f.startsWith('the '));

test("each include's own stages are compared with the seed's, not pooled under ship", () => {
  expect(stageLines(seedMap())).toEqual([]);
  // deploy's stages under deploy are right; one missing from ship is caught as ship's.
  const { ship, deploy } = SEED_INCLUDE_STAGES;
  expect(stageLines(seedMap({ ship: ship.slice(1), deploy }))).toEqual([
    `ship shows ${ship.slice(1).join(', ')}`,
  ]);
  expect(stageLines(seedMap({ ship, deploy: [] }))).toEqual(['deploy shows no stages']);
  // An include the seed does not expand must show none.
  expect(stageLines(seedMap({ ship, deploy, review: ['scope'] }))).toEqual(['review shows scope']);
});
