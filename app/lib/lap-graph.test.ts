import { expect, test } from 'bun:test';
import { foldGraph, type LapMapRow, lapGraph, pathOf, ranBlocks } from './lap-graph';
import type { StepAttemptRow } from './one-lap';

const row = (path: string, position: number, over: Partial<LapMapRow> = {}): LapMapRow => {
  const parts = path.split('/');
  return {
    pin: 'abc1234',
    path,
    parent_path: parts.length === 1 ? null : parts.slice(0, -1).join('/'),
    position,
    step_id: parts.at(-1) as string,
    kind: 'prompt',
    depends_on: [],
    ...over,
  };
};

const attempt = (step_id: string, minute: number, status = 'completed'): StepAttemptRow => ({
  step_id,
  status,
  started_at: new Date(Date.UTC(2026, 9, 25, 12, minute)),
  duration_ms: 1000,
  model: null,
  tokens_input: null,
  tokens_output: null,
  tokens_cache_read: null,
  tokens_cache_write: null,
  cost_usd: null,
  outcome: null,
  error: null,
  position: null,
});

test("a nested step's Archon id is its path joined with __", () => {
  expect(pathOf('ship__deliver__rounds__review__scope')).toBe('ship/deliver/rounds/review/scope');
  expect(pathOf('pick')).toBe('pick');
});

test('every step the lap ran is a node, on the map or beside it, with its own attempts', () => {
  const map = [
    row('pick', 1),
    row('ship', 2, { kind: 'include', depends_on: ['pick'] }),
    row('ship/intel', 3),
    row('review', 4, { depends_on: ['ship'] }),
  ];
  const attempts = [
    attempt('pick', 0),
    attempt('ship__intel', 1),
    attempt('ship__new', 2, 'running'),
    attempt('review', 3, 'skipped'),
  ];
  const lap = lapGraph(map, attempts, 'x', 'archon-loop');
  for (const a of attempts) expect(lap.steps.get(pathOf(a.step_id))?.attempts).toContain(a);
  expect(lap.steps.get('ship/new')).toMatchObject({ state: 'running', offMap: true });
  // The include's box: running while a step inside it runs.
  expect(lap.steps.get('ship')?.state).toBe('running');
  expect(lap.steps.get('review')?.state).toBe('skipped');
  // The new step sits inside ship's box, after intel, which started before it.
  expect(lap.graph.clusters.get('ship')).toEqual(['ship/intel', 'ship/new']);
  expect(lap.graph.edges).toContainEqual({ from: 'ship/intel', to: 'ship/new' });
});

test('a step the lap passed without running is skipped, with all inside it; one ahead is not reached', () => {
  const map = [
    row('pick', 1),
    row('build', 2, { depends_on: ['pick'] }),
    row('ship', 3, { kind: 'include', depends_on: ['pick'] }),
    row('ship/intel', 4),
    row('subject', 5, { depends_on: ['build', 'ship'] }),
    row('land', 6, { depends_on: ['subject'] }),
  ];
  const lap = lapGraph(
    map,
    [attempt('pick', 0), attempt('build', 1), attempt('subject', 2)],
    'x',
    'archon-loop',
  );
  expect(lap.steps.get('ship')?.state).toBe('skipped');
  expect(lap.steps.get('ship/intel')?.state).toBe('skipped');
  expect(lap.steps.get('land')?.state).toBe('not-reached');
  expect(lap.steps.get('subject')?.state).toBe('finished');
});

test('every block folds into one box saying how it stands in the lap, until opened', () => {
  const map = [
    row('pick', 1),
    row('build', 2, { depends_on: ['pick'] }),
    row('ship', 3, { kind: 'include', depends_on: ['pick'] }),
    row('ship/intel', 4),
    row('ship/deliver', 5, { kind: 'include', depends_on: ['intel'] }),
    row('ship/deliver/implement', 6),
    row('deploy', 7, { kind: 'include', depends_on: ['build', 'ship'] }),
    row('deploy/verify', 8),
  ];
  const simple = lapGraph(
    map,
    [attempt('pick', 0), attempt('build', 1), attempt('deploy__verify', 2, 'running')],
    'x',
    'archon-loop',
  );
  const { graph, folded, hidden } = foldGraph(simple, new Set());
  // A block where steps ran folds too: the loop opens as its top-level steps only.
  expect([...folded]).toEqual([
    ['ship', 3],
    ['deploy', 1],
  ]);
  expect(graph.steps.map((s) => s.id)).toEqual(['pick', 'build', 'ship', 'deploy']);
  expect([...graph.clusters.keys()]).toEqual([]);
  // Every hidden step is still there, in the loop's order.
  expect(hidden.map((s) => s.id)).toEqual([
    'ship/intel',
    'ship/deliver',
    'ship/deliver/implement',
    'deploy/verify',
  ]);
  const notes = (g: typeof graph, id: string) => g.steps.find((s) => s.id === id)?.folded?.notes;
  expect(notes(graph, 'ship')).toEqual(['skipped · 3 steps']);
  expect(notes(graph, 'deploy')).toEqual(['running: verify', '0 of 1 done']);
  // Opened by the viewer: ship shows again, and the block inside it folds until opened in turn.
  const opened = foldGraph(simple, new Set(['ship']));
  expect([...opened.folded]).toEqual([
    ['ship/deliver', 1],
    ['deploy', 1],
  ]);
  expect(opened.graph.steps.map((s) => s.id)).toContain('ship/intel');
  // A lap that ran inside ship: its box names the running step and counts what is done.
  const complex = lapGraph(
    map,
    [
      attempt('pick', 0),
      attempt('ship__intel', 1),
      attempt('ship__deliver__implement', 2, 'running'),
    ],
    'x',
    'archon-loop',
  );
  const shown = foldGraph(complex, new Set());
  expect(notes(shown.graph, 'ship')).toEqual(['running: deliver/implement', '1 of 3 done']);
  const failed = lapGraph(
    map,
    [attempt('pick', 0), attempt('ship__intel', 1, 'failed')],
    'x',
    'archon-loop',
  );
  expect(notes(foldGraph(failed, new Set()).graph, 'ship')).toEqual([
    'failed: intel',
    '0 of 3 done',
  ]);
});

test("a loop group's body steps, named <group>.<step> on every iteration, mark their pinned node once", () => {
  const map = [
    row('ship', 1, { kind: 'include' }),
    row('ship/rounds', 2, { kind: 'loop_group' }),
    row('ship/rounds/implement', 3),
    row('ship/rounds/review', 4, { kind: 'include', depends_on: ['implement'] }),
    row('ship/rounds/review/scope', 5),
  ];
  const lap = lapGraph(
    map,
    [
      attempt('ship__rounds.implement', 0),
      attempt('ship__rounds.review__scope', 1),
      attempt('ship__rounds.implement', 2),
      attempt('ship__rounds.review__scope', 3, 'running'),
    ],
    'x',
    'archon-loop',
  );
  // No duplicate nodes: the graph is the pinned map.
  expect(lap.graph.steps.map((s) => s.id)).toEqual(map.map((r) => r.path));
  expect([...lap.steps.values()].some((s) => s.offMap)).toBe(false);
  const implement = lap.steps.get('ship/rounds/implement');
  expect(implement?.state).toBe('finished');
  expect(implement?.attempts).toHaveLength(2);
  expect(lap.steps.get('ship/rounds/review/scope')?.state).toBe('running');
  expect(lap.steps.get('ship/rounds')?.state).toBe('running');
});

test("a loop group Archon skipped, as a simple lap skips ship's rounds, skips its body too", () => {
  const map = [
    row('pick', 1),
    row('ship', 2, { kind: 'include', depends_on: ['pick'] }),
    row('ship/rounds', 3, { kind: 'loop_group' }),
    row('ship/rounds/implement', 4),
    row('ship/rounds/review', 5, { kind: 'include', depends_on: ['implement'] }),
    row('ship/rounds/review/scope', 6),
    row('land', 7, { depends_on: ['ship'] }),
  ];
  const lap = lapGraph(
    map,
    [attempt('pick', 0), attempt('ship__rounds', 1, 'skipped'), attempt('land', 2)],
    'x',
    'archon-loop',
  );
  for (const path of ['ship', 'ship/rounds', 'ship/rounds/implement', 'ship/rounds/review/scope']) {
    expect(lap.steps.get(path)?.state).toBe('skipped');
  }
  // A lap still in a running rounds keeps the steps ahead of it as not reached.
  const running = lapGraph(
    map,
    [attempt('pick', 0), attempt('ship__rounds.implement', 1, 'running')],
    'x',
    'archon-loop',
  );
  expect(running.steps.get('ship/rounds/review/scope')?.state).toBe('not-reached');
});

test("a lap opens each top-level block it ran, ship's own steps on the fork's lit side", () => {
  const map = [
    row('claim', 1),
    row('build', 2, { depends_on: ['claim'], when_condition: "$pick.output.route == 'simple'" }),
    row('ship', 3, {
      kind: 'include',
      depends_on: ['claim', 'build'],
      trigger_rule: 'none_failed_min_one_success',
      when_condition: "$pick.output.route == 'complex'",
    }),
    row('ship/intel', 4),
    row('ship/deliver', 5, { kind: 'include', depends_on: ['intel'] }),
    row('ship/deliver/implement', 6),
    row('subject', 7, { depends_on: ['build', 'ship'], trigger_rule: 'all_done' }),
  ];
  const complex = lapGraph(
    map,
    [
      attempt('claim', 0),
      attempt('ship__intel', 1),
      attempt('ship__deliver__implement', 2, 'running'),
    ],
    'x',
    'archon-loop',
  );
  expect(ranBlocks(complex)).toEqual(['ship']);
  const { folded } = foldGraph(complex, new Set(ranBlocks(complex)));
  expect([...folded.keys()]).toEqual(['ship/deliver']);
  // The fork is a fork: build waits on nothing but claim, and the lap did not take it.
  expect(complex.graph.edges).toContainEqual({ from: 'claim', to: 'ship', label: 'complex' });
  expect(complex.graph.edges).not.toContainEqual({ from: 'build', to: 'ship' });
  const simple = lapGraph(
    map,
    [attempt('claim', 0), attempt('build', 1), attempt('subject', 2)],
    'x',
    'archon-loop',
  );
  expect(ranBlocks(simple)).toEqual([]);
  expect(simple.steps.get('ship')?.state).toBe('skipped');
  expect(foldGraph(simple, new Set(ranBlocks(simple))).folded.get('ship')).toBe(3);
});

test("step links open each step at the lap's pin, and at the current version when there is none", () => {
  const attempts = [attempt('pick', 0), attempt('extra', 1)];
  const pinned = lapGraph([row('pick', 1, { pin: 'old1234' })], attempts, 'x', 'archon-loop');
  expect(pinned.graph.steps.map((s) => s.href)).toEqual([
    '/f/x/steps/archon-loop/pick?at=old1234',
    '/f/x/steps/archon-loop/extra?at=old1234',
  ]);
  const unpinned = lapGraph([], attempts, 'x', 'archon-loop');
  expect(unpinned.graph.steps.every((s) => !s.href?.includes('?at='))).toBe(true);
});

test('a step completed in one round and skipped undated in the next ends skipped, the skip its last attempt', () => {
  const skip: StepAttemptRow = {
    ...attempt('pick', 9, 'skipped'),
    started_at: null,
    event_at: new Date(Date.UTC(2026, 9, 25, 12, 9)),
  };
  const lap = lapGraph([row('pick', 1)], [attempt('pick', 1), skip], 'x', 'archon-build-queue');
  expect(lap.steps.get('pick')?.state).toBe('skipped');
  expect(lap.steps.get('pick')?.attempts.at(-1)).toBe(skip);
});
