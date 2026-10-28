import { expect, test } from 'bun:test';
import {
  dependents,
  findStep,
  joinParts,
  type NestingRow,
  nesting,
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

test('a step is found by its workflow and its path in that workflow', () => {
  const rows = [step('a'), step('a', { workflow: 'other' }), step('ship/a')];
  expect(findStep(rows, 'wf', 'a')).toBe(rows[0]);
  expect(findStep(rows, 'wf', 'ship/a')).toBe(rows[2]);
  expect(findStep(rows, 'wf', 'missing')).toBeUndefined();
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

function nested(
  relation: NestingRow['relation'],
  workflow: string,
  path: string,
  position: number,
  open: [string, string],
): NestingRow {
  return {
    relation,
    workflow,
    path,
    position,
    step_id: path.slice(path.lastIndexOf('/') + 1),
    kind: 'command',
    open_workflow: open[0],
    open_path: open[1],
  };
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

test("nesting's links open each screen at the version the step is opened at", () => {
  const { inside, includedAt } = nesting(
    [
      nested('inside', 'archon-ship-block', 'deliver/rounds/implement', 2, [
        'archon-deliver-block',
        'rounds/implement',
      ]),
      nested('included_at', 'archon-loop', 'ship/deliver', 4, ['archon-loop', 'ship']),
    ],
    step('deliver', { workflow: 'archon-ship-block' }),
    'p1',
  );
  expect(inside.map((node) => node.href)).toEqual([
    '/steps/archon-deliver-block/rounds%2Fimplement?at=p1',
  ]);
  expect(includedAt.map((place) => place.href)).toEqual(['/steps/archon-loop/ship?at=p1']);
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
  const deliver = step('deliver', { workflow: 'archon-ship-block' });
  const { inside } = nesting(
    [
      nested('inside', 'archon-ship-block', 'deliver/rounds/reshape/implement', 7, [
        'archon-implement',
        'implement',
      ]),
      nested('inside', 'archon-ship-block', 'deliver/rounds/implement', 2, [
        'archon-deliver-block',
        'rounds/implement',
      ]),
      nested('inside', 'archon-ship-block', 'deliver/rounds/implement/implement', 3, [
        'archon-implement',
        'implement',
      ]),
    ],
    deliver,
  );
  expect(inside).toEqual([
    {
      label: 'rounds/implement',
      depth: 1,
      kind: 'command',
      href: '/steps/archon-deliver-block/rounds%2Fimplement',
    },
    {
      label: 'rounds/implement/implement',
      depth: 2,
      kind: 'command',
      href: '/steps/archon-implement/implement',
    },
    {
      label: 'rounds/reshape/implement',
      depth: 2,
      kind: 'command',
      href: '/steps/archon-implement/implement',
    },
  ]);
});

test('the places an include puts a step are by workflow, then in declaration order', () => {
  const implement = step('implement', { workflow: 'archon-implement' });
  const { inside, includedAt } = nesting(
    [
      nested('included_at', 'archon-ship-block', 'deliver/rounds/implement/implement', 5, [
        'archon-deliver-block',
        'rounds/implement',
      ]),
      nested('included_at', 'archon-deliver-block', 'rounds/reshape/implement', 9, [
        'archon-deliver-block',
        'rounds/reshape',
      ]),
      nested('included_at', 'archon-deliver-block', 'rounds/implement/implement', 3, [
        'archon-deliver-block',
        'rounds/implement',
      ]),
    ],
    implement,
  );
  expect(inside).toEqual([]);
  expect(includedAt.map((place) => `${place.workflow} ${place.path} ${place.href}`)).toEqual([
    'archon-deliver-block rounds/implement/implement /steps/archon-deliver-block/rounds%2Fimplement',
    'archon-deliver-block rounds/reshape/implement /steps/archon-deliver-block/rounds%2Freshape',
    'archon-ship-block deliver/rounds/implement/implement /steps/archon-deliver-block/rounds%2Fimplement',
  ]);
});
