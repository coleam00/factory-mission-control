import { expect, test } from 'bun:test';
import { dependents, findStep, joinParts, type StepRow } from './step-detail';

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
