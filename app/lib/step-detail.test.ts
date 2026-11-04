import { expect, test } from 'bun:test';
import {
  dependents,
  isIncluded,
  joinParts,
  type NestingRow,
  nesting,
  placeOf,
  placesOf,
  type StepRow,
  stepHref,
  stepVersions,
  versionName,
} from './step-detail';

function step(path: string, fields: Partial<StepRow> = {}): StepRow {
  const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : null;
  return {
    workflow: 'wf',
    path,
    parent_path: parent,
    position: 0,
    step_id: path.slice(path.lastIndexOf('/') + 1),
    kind: 'command',
    description: null,
    model: null,
    when_condition: null,
    depends_on: [],
    trigger_rule: null,
    include: null,
    command_file: null,
    script: null,
    script_file: null,
    runtime: null,
    bash: null,
    prompt: null,
    defined_in: 'wf',
    file: 'wf/wf.yaml',
    ...fields,
  };
}

test('a place is found through the includes and loop groups on its path', () => {
  const rows = [
    step('a'),
    step('a', { workflow: 'other' }),
    step('ship', { workflow: 'top', include: 'mid', position: 1 }),
    step('rounds', { workflow: 'mid', kind: 'loop_group', position: 2 }),
    step('rounds/review', { workflow: 'mid', include: 'leaf', position: 3 }),
    step('code', { workflow: 'leaf', position: 4 }),
  ];
  expect(placeOf(rows, 'wf', 'a')?.step).toBe(rows[0]);
  expect(placeOf(rows, 'wf', 'a')?.around).toEqual([]);
  const placed = placeOf(rows, 'top', 'ship/rounds/review/code');
  expect(placed?.step).toBe(rows[5]);
  expect(placed?.around.map((e) => [e.path, e.row])).toEqual([
    ['ship', rows[2]],
    ['ship/rounds', rows[3]],
    ['ship/rounds/review', rows[4]],
  ]);
});

test('a path with a missing segment, or one through a plain step, is no place', () => {
  const rows = [step('a'), step('ship', { include: 'leaf' }), step('code', { workflow: 'leaf' })];
  expect(placeOf(rows, 'wf', 'missing')).toBeUndefined();
  expect(placeOf(rows, 'wf', 'ship/missing')).toBeUndefined();
  expect(placeOf(rows, 'wf', 'a/code')).toBeUndefined();
});

test('places are by top-level workflow, then declaration order, not by step id', () => {
  const rows = [
    step('zeta', { workflow: 'top', include: 'block', position: 1 }),
    step('alpha', { workflow: 'top', include: 'block', position: 2 }),
    step('main', { workflow: 'app', include: 'block', position: 5 }),
    step('code', { workflow: 'block' }),
  ];
  expect(isIncluded(rows, 'block')).toBe(true);
  expect(isIncluded(rows, 'top')).toBe(false);
  expect(placesOf(rows, 'block', 'code')).toEqual([
    { workflow: 'app', path: 'main/code' },
    { workflow: 'top', path: 'zeta/code' },
    { workflow: 'top', path: 'alpha/code' },
  ]);
});

test('a step in a workflow nothing includes is its own only place', () => {
  expect(placesOf([step('a')], 'wf', 'a')).toEqual([{ workflow: 'wf', path: 'a' }]);
});

test('a place two includes deep is found through each intermediate block', () => {
  const rows = [
    step('ship', { workflow: 'top', include: 'mid', position: 1 }),
    step('deliver', { workflow: 'mid', include: 'leaf', position: 2 }),
    step('deliver', { workflow: 'mid2', include: 'leaf', position: 1 }),
    step('regress', { workflow: 'top', include: 'mid2', position: 3 }),
    step('code', { workflow: 'leaf' }),
  ];
  expect(placesOf(rows, 'leaf', 'code')).toEqual([
    { workflow: 'top', path: 'ship/deliver/code' },
    { workflow: 'top', path: 'regress/deliver/code' },
  ]);
});

test('outputs are the steps of the same scope that depend on it, in declaration order', () => {
  const a = step('a', { position: 0 });
  const rows = [
    a,
    step('c', { position: 2, depends_on: ['a'] }),
    step('b', { position: 1, depends_on: ['a', 'x'] }),
    step('ship/d', { position: 3, depends_on: ['a'] }),
    step('e', { position: 4, depends_on: ['a'], workflow: 'other' }),
  ];
  expect(dependents(rows, a).map((s) => s.path)).toEqual(['b', 'c']);
});

test('parts join in part order per file, and a missing part text joins as nothing', () => {
  const files = joinParts(
    [
      { path: 'x.md', part: 1, chunk: 'world' },
      { path: 'y.md', part: 0, chunk: null },
      { path: 'x.md', part: 0, chunk: 'hello ' },
    ],
    (row) => row.path,
  );
  expect(files).toEqual(
    new Map([
      ['x.md', 'hello world'],
      ['y.md', ''],
    ]),
  );
});

function nested(path: string, position: number): NestingRow {
  return { path, position, step_id: path.slice(path.lastIndexOf('/') + 1), kind: 'command' };
}

test("a nested path's slash is encoded in the step's link", () => {
  expect(stepHref('archon-deliver-block', 'rounds/implement')).toBe(
    '/steps/archon-deliver-block/rounds%2Fimplement',
  );
});

test("a step's link keeps the version it is opened at, and has none for the current version", () => {
  expect(stepHref('archon-loop', 'review', '8e3e1cef/x')).toBe(
    '/steps/archon-loop/review?at=8e3e1cef%2Fx',
  );
  expect(stepHref('archon-loop', 'review', null)).toBe('/steps/archon-loop/review');
  expect(stepHref('archon-loop', 'review', '')).toBe('/steps/archon-loop/review');
});

test("nesting's links open each node's place in the address's workflow at the version", () => {
  const inside = nesting(
    [nested('ship/deliver/rounds/implement', 2)],
    'archon-loop',
    'ship/deliver',
    'p1',
  );
  expect(inside.map((node) => node.href)).toEqual([
    '/steps/archon-loop/ship%2Fdeliver%2Frounds%2Fimplement?at=p1',
  ]);
});

test('the versions a step opens at are newest first, the current one marked, a bare pin not recorded', () => {
  expect(
    stepVersions([
      {
        sha: 'aaaa1111old',
        reason: null,
        committed_at: new Date('2026-01-01T00:00:00Z'),
        is_current: false,
      },
      {
        sha: 'bbbb2222new',
        reason: 'two',
        committed_at: new Date('2026-02-01T00:00:00Z'),
        is_current: true,
      },
    ]),
  ).toEqual([
    { sha: 'bbbb2222new', label: 'bbbb2222 2026-02-01', reason: 'two', current: true },
    { sha: 'aaaa1111old', label: 'aaaa1111 2026-01-01', reason: 'not recorded', current: false },
  ]);
});

test('a sentence names the version the step is shown at', () => {
  expect(versionName(null)).toBe('the current version');
  expect(versionName('8e3e1cefaf1e1b7955789d6a43a81b6c2dbd7082')).toBe('version 8e3e1cef');
});

test('repeated occurrences beneath a step are two entries, by their path beneath it, in order', () => {
  const inside = nesting(
    [
      nested('deliver/rounds/reshape/implement', 7),
      nested('deliver/rounds/implement', 2),
      nested('deliver/rounds/implement/implement', 3),
    ],
    'archon-ship-block',
    'deliver',
  );
  expect(inside.map((node) => [node.label, node.depth, node.href])).toEqual([
    ['rounds/implement', 1, '/steps/archon-ship-block/deliver%2Frounds%2Fimplement'],
    [
      'rounds/implement/implement',
      2,
      '/steps/archon-ship-block/deliver%2Frounds%2Fimplement%2Fimplement',
    ],
    [
      'rounds/reshape/implement',
      2,
      '/steps/archon-ship-block/deliver%2Frounds%2Freshape%2Fimplement',
    ],
  ]);
});
