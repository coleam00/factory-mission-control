import { expect, test } from 'bun:test';
import { foldGraph, type LapMapRow, LANE_STEPS, lapGraph, laneMarks, pathOf } from './lap-graph';
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
    detail_workflow: 'archon-loop',
    detail_path: path,
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
  const lap = lapGraph(map, attempts);
  for (const a of attempts) expect(lap.steps.get(pathOf(a.step_id))?.attempts).toContain(a);
  expect(lap.steps.get('ship/new')).toMatchObject({ state: 'running', offMap: true });
  // The include's box: running while a step inside it runs.
  expect(lap.steps.get('ship')?.state).toBe('running');
  expect(lap.steps.get('review')?.state).toBe('skipped');
  // The new step sits inside ship's box, after intel, which started before it.
  expect(lap.graph.clusters.get('ship')).toEqual(['ship/intel', 'ship/new']);
  expect(lap.graph.edges).toContainEqual({ from: 'ship/intel', to: 'ship/new' });
});

test("a lane's marks follow the loop's top-level steps, build and ship as one", () => {
  const marks = laneMarks(['pick completed', 'claim completed', 'build running', 'tally skipped']);
  expect(marks.map((m) => m.step)).toEqual([...LANE_STEPS, 'tally']);
  expect(Object.fromEntries(marks.map((m) => [m.step, m.state]))).toMatchObject({
    pick: 'finished',
    claim: 'finished',
    'build/ship': 'running',
    // Passed: tally, the last step the lap ran, comes after them all.
    subject: 'skipped',
    tally: 'skipped',
  });
  expect(laneMarks(null).every((m) => m.state === 'not-reached')).toBe(true);
  expect(laneMarks(['ship__deliver__implement failed'])[2]).toEqual({
    step: 'build/ship',
    state: 'failed',
  });
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
  const lap = lapGraph(map, [attempt('pick', 0), attempt('build', 1), attempt('subject', 2)]);
  expect(lap.steps.get('ship')?.state).toBe('skipped');
  expect(lap.steps.get('ship/intel')?.state).toBe('skipped');
  expect(lap.steps.get('land')?.state).toBe('not-reached');
  expect(lap.steps.get('subject')?.state).toBe('finished');
});

test('a lane mark the lap went past is skipped; one ahead of it is not reached', () => {
  const marks = Object.fromEntries(
    laneMarks([
      'pick completed',
      'claim completed',
      'build completed',
      'subject completed',
      'check-app running',
    ]).map((m) => [m.step, m.state]),
  );
  expect(marks).toMatchObject({
    briefs: 'skipped',
    'check-app': 'running',
    evidence: 'not-reached',
  });
});

test('a block where no step ran folds into one box counting its steps; one that ran stays open', () => {
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
  const simple = lapGraph(map, [
    attempt('pick', 0),
    attempt('build', 1),
    attempt('deploy__verify', 2, 'running'),
  ]);
  const { graph, folded } = foldGraph(simple, new Set());
  expect([...folded]).toEqual([['ship', 3]]);
  expect(graph.steps.map((s) => s.id)).toEqual([
    'pick',
    'build',
    'ship',
    'deploy',
    'deploy/verify',
  ]);
  expect([...graph.clusters.keys()]).toEqual(['deploy']);
  // Opened by the viewer: ship shows again, and its own untouched block inside it folds.
  const opened = foldGraph(simple, new Set(['ship']));
  expect([...opened.folded]).toEqual([['ship/deliver', 1]]);
  expect(opened.graph.steps.map((s) => s.id)).toContain('ship/intel');
  // A lap that ran inside ship keeps ship open, and only the inner block that did not run folds.
  const complex = lapGraph(map, [attempt('pick', 0), attempt('ship__intel', 1, 'running')]);
  expect([...foldGraph(complex, new Set()).folded]).toEqual([
    ['ship/deliver', 1],
    ['deploy', 1],
  ]);
});
