import { expect, test } from 'bun:test';
import { type ArchDiffRow, defaultPair, diffVersions } from './arch-diff';

const version = (digest: string): ArchDiffRow => ({
  digest,
  kind: 'version',
  workflow: null,
  entries: [],
});

/** One version of `archon-loop`: each step `path:content`, each edge `from>to`. */
const loop = (digest: string, steps: string[], edges: string[] = []): ArchDiffRow[] => [
  version(digest),
  {
    digest,
    kind: 'step',
    workflow: 'archon-loop',
    entries: steps.map((s) => s.replace(':', '\t')),
  },
  {
    digest,
    kind: 'edge',
    workflow: 'archon-loop',
    entries: edges.map((e) => e.replace('>', '\t')),
  },
];

const steps = (rows: ArchDiffRow[]) => {
  const result = diffVersions(rows, 'a', 'b');
  if (result.status !== 'compared') throw new Error(result.status);
  const names = (list: { name: string }[]) => list.map((s) => s.name);
  const { added, removed, changed } = result.diff.step;
  return { added: names(added), removed: names(removed), changed: names(changed) };
};

test('a dependant does not change when a step it depended on was removed or added', () => {
  expect(
    steps([
      ...loop(
        'a',
        ['subject:1', 'briefs:2', 'check:3'],
        ['subject>briefs', 'briefs>check', 'subject>check'],
      ),
      ...loop('b', ['subject:1', 'check:3', 'tally:4'], ['subject>check', 'check>tally']),
    ]),
  ).toEqual({ added: ['tally'], removed: ['briefs'], changed: [] });
});

test('a step changes when what it says or a dependency both versions have changes', () => {
  expect(
    steps([
      ...loop('a', ['subject:1', 'check:2', 'review:3'], ['subject>check', 'check>review']),
      ...loop('b', ['subject:1', 'check:2', 'review:9'], ['subject>review']),
    ]),
  ).toEqual({ added: [], removed: [], changed: ['check', 'review'] });
});

test('a subagent is keyed by its workflow, step and name', () => {
  const agent = (digest: string, workflow: string, content: string): ArchDiffRow => ({
    digest,
    kind: 'subagent',
    workflow,
    entries: [`manage\tholdout-writer\t${content}`],
  });
  const result = diffVersions(
    [
      version('a'),
      version('b'),
      agent('a', 'archon-manager', 'x'),
      agent('a', 'archon-holdouts', 'x'),
      agent('b', 'archon-manager', 'y'),
      agent('b', 'archon-holdouts', 'x'),
    ],
    'a',
    'b',
  );
  if (result.status !== 'compared') throw new Error(result.status);
  expect(result.changes).toBe(1);
  expect(result.diff.subagent.changed).toEqual([
    { kind: 'subagent', workflow: 'archon-manager', step: 'manage', name: 'holdout-writer' },
  ]);
});

test('with no pair named, the diff opens on the newest two recorded versions, older first', () => {
  const at = (digest: string, day: number): ArchDiffRow => ({
    ...version(digest),
    first_run_at: new Date(Date.UTC(2026, 9, day)),
  });
  const arch = (digest: string): ArchDiffRow => ({
    digest,
    kind: 'workflow',
    workflow: null,
    entries: ['archon-loop\tc'],
  });
  const rows = [at('v1', 1), arch('v1'), at('v3', 9), arch('v3'), at('v2', 5), arch('v2')];
  expect(defaultPair(rows)).toEqual({ a: 'v2', b: 'v3', recorded: true });
  // A newest version not parsed yet does not hide the diff that can be shown.
  expect(defaultPair([...rows, at('v4', 12)])).toEqual({ a: 'v2', b: 'v3', recorded: true });
  // Fewer than two recorded: the newest two, whatever they hold.
  expect(defaultPair([at('v1', 1), arch('v1'), at('v2', 5)])).toEqual({
    a: 'v1',
    b: 'v2',
    recorded: false,
  });
  expect(defaultPair([at('v1', 1), arch('v1')])).toBeNull();
  expect(defaultPair([])).toBeNull();
});
