import { expect, test } from 'bun:test';
import { type ArchDiffRow, diffVersions } from './arch-diff';

const step = (digest: string, id: string, depends_on: string[] = [], content = id): ArchDiffRow => ({
  digest,
  kind: 'step',
  workflow: 'archon-loop',
  step: id,
  name: id,
  content,
  depends_on,
});

const changedSteps = (rows: ArchDiffRow[]) => {
  const result = diffVersions(rows, 'a', 'b');
  if (result.status !== 'compared') throw new Error(result.status);
  return result.diff.step.changed.map((s) => s.name);
};

test("a dependant does not change when a step it named was removed, or when its list is reordered", () => {
  expect(
    changedSteps([
      step('a', 'subject'),
      step('a', 'briefs', ['subject']),
      step('a', 'check', ['subject', 'briefs']),
      step('a', 'review', ['check', 'subject']),
      step('b', 'subject'),
      step('b', 'check', ['subject']),
      step('b', 'review', ['subject', 'check']),
    ]),
  ).toEqual([]);
});

test('a step changes when its content or a dependency on a step both versions have changes', () => {
  expect(
    changedSteps([
      step('a', 'subject'),
      step('a', 'check', ['subject']),
      step('a', 'review', ['check'], 'old prompt'),
      step('b', 'subject'),
      step('b', 'check'),
      step('b', 'review', ['check'], 'new prompt'),
    ]),
  ).toEqual(['check', 'review']);
});

test('the same name in another kind or workflow is a different item', () => {
  const result = diffVersions(
    [
      step('a', 'review'),
      { ...step('b', 'review'), workflow: 'archon-manager' },
      { ...step('b', 'review'), kind: 'prompt', workflow: null, step: null },
    ],
    'a',
    'b',
  );
  if (result.status !== 'compared') throw new Error(result.status);
  expect(result.changes).toBe(3);
  expect(result.diff.step.removed.map((s) => s.workflow)).toEqual(['archon-loop']);
  expect(result.diff.step.added.map((s) => s.workflow)).toEqual(['archon-manager']);
  expect(result.diff.prompt.added.map((s) => s.name)).toEqual(['review']);
});
