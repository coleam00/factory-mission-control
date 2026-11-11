import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { allCards, FACTORY_MAP } from './factory-map';
import { gateOutcomes, type MapRightNowRow } from './live';

const root = join(import.meta.dir, '..', '..');
const read = (...path: string[]) => readFileSync(join(root, ...path), 'utf8');
// A computed path keeps tsc out of the pack, whose `.ts` import extensions this config refuses.
const pack = (...path: string[]) => import(join(root, 'fixtures', 'pack', ...path));

test("the gate's 'return' and 'ask' are pinned sweep actions", async () => {
  const pinned = await pack('queue', 'sdlc', '.shared', 'merge.ts');
  expect(pinned.SWEEP_ACTIONS).toContain('return');
  expect(pinned.SWEEP_ACTIONS).toContain('ask');
});

type Decide = (
  items: unknown[],
  sweep: unknown,
) => { number: number; action: string; reason: string }[];

// `decide()` is not exported and its module runs the record step on import, and the pin is not
// ours to edit. So the pinned text is loaded with only its closing `main()` call swapped for an
// export; its relative imports still resolve to the real pinned helpers.
const MAIN_CALL = /\r?\ntry \{\r?\n {2}main\(\);\r?\n\} catch \(error\) \{[\s\S]*?\r?\n\}\r?\n?$/;
async function pinnedDecide(): Promise<Decide> {
  const path = join(
    root,
    'fixtures',
    'pack',
    'queue',
    'sdlc',
    'merge-queue',
    'scripts',
    'record.ts',
  );
  const source = readFileSync(path, 'utf8');
  if (!MAIN_CALL.test(source)) {
    throw new Error('record.ts no longer ends with the main() call this test strips');
  }
  Bun.plugin({
    name: 'pinned-record-decide',
    setup(build) {
      build.onLoad({ filter: /record\.ts$/ }, (args) =>
        args.path.endsWith(['merge-queue', 'scripts', 'record.ts'].join(sep))
          ? { loader: 'ts', contents: source.replace(MAIN_CALL, '\nexport { decide };\n') }
          : undefined,
      );
    },
  });
  const { decide } = await import(path);
  expect(typeof decide).toBe('function');
  return decide;
}

// Binds the claimed-set and first-per-number rules. Refused returns (empty brief) are outside what
// the gate restates: it lists the sweep's decision, and the record step may still wait on it.
test('the gate lists the sweep returns and asks the pinned decide() claims, first per number', async () => {
  const decide = await pinnedDecide();
  const pr = (number: number) => ({ repo: { host: 'github.com', path: 'o/r' }, number });
  const item = (number: number) => ({
    item: pr(number + 100),
    pr: pr(number),
    url: `https://github.com/o/r/pull/${number}`,
    facts: null,
    record: null,
  });
  const items = [item(1), item(2), item(3), item(4), item(5)];
  const sweepDecision = (number: number, action: string, extra = {}) => ({
    number,
    action,
    class: 'clear',
    head: 'abcdef0',
    reran: false,
    reason: `${action} ${number} ${Object.keys(extra).length}`,
    brief: 'b',
    attention: null,
    ...extra,
  });
  const decisions = [
    sweepDecision(2, 'return'),
    sweepDecision(9, 'return'),
    sweepDecision(1, 'merged'),
    sweepDecision(2, 'ask', { x: 1 }),
    sweepDecision(5, 'ask', { attention: { choices: [{ effect: 'none' }] } }),
    sweepDecision(4, 'wait'),
    sweepDecision(1, 'return', { x: 1 }),
  ];
  const row: MapRightNowRow = {
    kind: 'outcomes',
    run_id: 'r1',
    at: new Date('2026-10-24T09:00:00Z'),
    decisions: JSON.stringify(decisions),
    merged: '[]',
    asked: '5',
    claimed: JSON.stringify(items),
    revision: null,
    health: null,
    status: null,
    repository: 'o/r',
  };
  const expected = decide(items, {
    decisions,
    base: { summary: '', reran: false, attention: null },
    summary: '',
  }).flatMap(({ number, action, reason }) =>
    action === 'return'
      ? [[number, 'sweep: sent back', reason]]
      : action === 'ask' && number === 5
        ? [[number, 'sweep: asked', reason]]
        : [],
  );
  const listed = gateOutcomes([row]).map((o) => [o.number, o.outcome, o.reason]);
  expect(listed.length).toBeGreaterThan(1);
  expect(listed.map(([n]) => n)).toContain(5);
  expect(listed).toEqual(expected);
});

// One row per `refusals.push` in the pinned `gateRefusals`: the start of what it pushes, and the
// `m-gate` card line that says it. The card's own wording stays the owner's.
const REFUSALS: readonly (readonly [string, string])[] = [
  ['it is $', 'It refuses a PR that is not open: already merged or closed.'],
  ['it is a draft', 'It refuses a draft.'],
  ['it targets ', 'It refuses a PR that does not target the default branch.'],
  ['its head is ', "It refuses when the PR's head is no longer the commit the sweep decided on."],
  [
    'it lacks ',
    'It refuses a PR that is behind the default branch, unless the forge says it merges cleanly.',
  ],
  [
    'its review verdict is $',
    "It refuses unless a maintainer's review verdict says Ready, for exactly the PR's head.",
  ],
  [
    'its review verdict is for ',
    "It refuses unless a maintainer's review verdict says Ready, for exactly the PR's head.",
  ],
  [
    'CI at its head is ',
    "It refuses unless CI at the PR's head is green: a failing or unfinished check holds it.",
  ],
  ['the default branch ', "It refuses while the default branch's CI is red."],
  [
    'no validation is recorded',
    "It refuses, where the project trusts its own validation instead of forge CI, unless a passing validation is recorded at the PR's head.",
  ],
  [
    'its validation is for ',
    "It refuses, where the project trusts its own validation instead of forge CI, unless a passing validation is recorded at the PR's head.",
  ],
  [
    'its validation at ',
    "It refuses, where the project trusts its own validation instead of forge CI, unless a passing validation is recorded at the PR's head.",
  ],
];

test('the gate card lists exactly the pinned gate refusals', () => {
  const source = read('fixtures', 'pack', 'queue', 'sdlc', '.shared', 'merge.ts');
  const start = source.indexOf('export function gateRefusals(');
  // The CI refusal is pushed as `unvalidated`; its texts are read from `ciRefusal` below.
  const body = source
    .slice(start, source.indexOf('return refusals;', start))
    .replace('refusals.push(unvalidated)', '');
  const ciStart = source.indexOf('function ciRefusal(');
  const ciBody = source.slice(ciStart, source.indexOf('\n}\n', ciStart));
  const ciReturn = /return\s+(?:\w+\.\w+\s*\?\s*null\s*:\s*)?['"`]([^'"`]*)/g;
  const pushed = [
    ...[...body.matchAll(/refusals\.push\(\s*['"`]([^'"`]*)/g)].map((m) => m[1] as string),
    ...[...ciBody.matchAll(ciReturn)].map((m) => m[1] as string),
  ];
  expect(pushed.length).toBeGreaterThan(0);
  // Every non-null return in `ciRefusal` is a refusal, whether or not its text is a literal.
  const ciRefusals = ciBody.match(/return\s+(?!null\b)/g)?.length ?? 0;
  expect(pushed.length).toBe(body.split('refusals.push(').length - 1 + ciRefusals);

  for (const text of pushed) {
    expect(REFUSALS.filter(([prefix]) => text.startsWith(prefix)).length).toBe(1);
  }
  for (const [prefix] of REFUSALS) {
    expect(pushed.filter((text) => text.startsWith(prefix)).length).toBe(1);
  }

  const gate = allCards(FACTORY_MAP).find((c) => c.id === 'm-gate');
  const lines = (gate?.details?.how ?? []).filter((line) => line.startsWith('It refuses'));
  expect(new Set(REFUSALS.map(([, line]) => line))).toEqual(new Set(lines));
});
