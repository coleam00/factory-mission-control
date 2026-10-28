import { expect, test } from 'bun:test';
import {
  type Box,
  type HomeMapRow,
  homeMap,
  layoutSteps,
  reduceEdges,
  stepLabelLines,
} from './home-map';

const workflow = (role: 'input' | 'manager', name: string): HomeMapRow => ({
  role,
  workflow: name,
  path: null,
  parent_path: null,
  position: null,
  step_id: null,
  kind: null,
  depends_on: null,
  detail_workflow: name,
  detail_path: null,
  lap_factory: null,
  laps: 0,
  is_current: false,
});

const step = (
  path: string,
  position: number,
  dependsOn: string[],
  extra: Partial<HomeMapRow> = {},
): HomeMapRow => {
  const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : null;
  return {
    role: parent === null ? 'step' : 'stage',
    workflow: 'wf-loop',
    path,
    parent_path: parent,
    position,
    step_id: path.slice(path.lastIndexOf('/') + 1),
    kind: 'script',
    depends_on: dependsOn,
    detail_workflow: parent === null ? 'wf-loop' : 'wf-block',
    detail_path: parent === null ? path : path.slice(path.indexOf('/') + 1),
    lap_factory: null,
    laps: 0,
    is_current: false,
    ...extra,
  };
};

// Out of order, as a live query may deliver them.
/** The factories the server's factories file names. */
const SHOWN = ['here', 'a-other', 'b-other'];

const rows: HomeMapRow[] = [
  step('c', 9, ['b']),
  workflow('manager', 'wf-manager'),
  step('b/two', 3, ['one'], { lap_factory: 'here', laps: 2, is_current: true }),
  step('a', 0, []),
  workflow('input', 'wf-writer'),
  step('b', 1, ['a'], { kind: 'include' }),
  step('b/one', 2, []),
];

test('the loop is in declaration order, each expanded step followed by its stages', () => {
  const map = homeMap(rows, SHOWN);
  expect(map.loop.steps.map((n) => n.id)).toEqual(['a', 'b', 'b/one', 'b/two', 'c']);
  expect(map.loop.steps.map((n) => n.role)).toEqual(['step', 'step', 'stage', 'stage', 'step']);
  expect(map.loop.clusters).toEqual(new Map([['b', ['b/one', 'b/two']]]));
});

test("a stage's depends_on names its siblings, and a stage with none hangs off its step", () => {
  const { edges } = homeMap(rows, SHOWN).loop;
  expect(edges).toContainEqual({ from: 'b', to: 'b/one' });
  expect(edges).toContainEqual({ from: 'b/one', to: 'b/two' });
  expect(edges).not.toContainEqual({ from: 'one', to: 'b/two' });
});

test('inputs, the manager and the outputs frame the loop', () => {
  const map = homeMap(rows, SHOWN);
  expect(map.inputs.map((n) => n.label)).toEqual([
    'Product document',
    'wf-writer',
    'Owner decisions',
  ]);
  expect(map.manager.map((n) => n.label)).toEqual(['wf-manager']);
  expect(map.outputs).toHaveLength(5);
});

test('an edge another path already implies is not drawn', () => {
  const edges = [
    { from: 'a', to: 'b' },
    { from: 'b', to: 'c' },
    { from: 'a', to: 'c' },
    { from: 'c', to: 'd' },
  ];
  expect(reduceEdges(edges)).toEqual([
    { from: 'a', to: 'b' },
    { from: 'b', to: 'c' },
    { from: 'c', to: 'd' },
  ]);
  const map = homeMap([...rows, step('d', 10, ['a', 'c'])], SHOWN);
  expect(map.loop.edges).toContainEqual({ from: 'c', to: 'd' });
  expect(map.loop.edges).not.toContainEqual({ from: 'a', to: 'd' });
});

test('a step links to its own workflow, a stage to the workflow its step includes', () => {
  const map = homeMap(rows, SHOWN);
  const href = (id: string) => map.loop.steps.find((n) => n.id === id)?.href;
  expect(href('a')).toBe('/steps/wf-loop/a');
  expect(href('b/two')).toBe('/steps/wf-block/two');
  expect(map.loop.steps.find((n) => n.id === 'b/two')?.liveCount).toBe(2);
});

test("a step with several factories' laps is one node: the address factory's count, every factory listed", () => {
  const map = homeMap(
    [
      ...rows,
      step('b/two', 3, ['one'], { lap_factory: 'b-other', laps: 3 }),
      step('b/two', 3, ['one'], { lap_factory: 'a-other', laps: 4 }),
    ],
    SHOWN,
  );
  expect(map.loop.steps.map((n) => n.id)).toEqual(['a', 'b', 'b/one', 'b/two', 'c']);
  const two = map.loop.steps.find((n) => n.id === 'b/two');
  expect(two?.liveCount).toBe(2);
  expect(two?.factories).toEqual([
    { factory: 'here', laps: 2, current: true },
    { factory: 'a-other', laps: 4, current: false },
    { factory: 'b-other', laps: 3, current: false },
  ]);
  expect(map.loop.steps.find((n) => n.id === 'a')?.factories).toEqual([]);
  expect(map.loop.edges.filter((e) => e.to === 'b/two')).toEqual([{ from: 'b/one', to: 'b/two' }]);
});

test('a factory the factories file does not name is not on the map, even where it alone has laps', () => {
  const map = homeMap(
    [
      ...rows.filter((r) => r.path !== 'a'),
      step('b/two', 3, ['one'], { lap_factory: 'unlisted', laps: 5 }),
      step('a', 0, [], { lap_factory: 'unlisted', laps: 1 }),
    ],
    SHOWN,
  );
  expect(map.loop.steps.map((n) => n.id)).toEqual(['a', 'b', 'b/one', 'b/two', 'c']);
  expect(map.loop.steps.find((n) => n.id === 'b/two')?.factories).toEqual([
    { factory: 'here', laps: 2, current: true },
  ]);
  const a = map.loop.steps.find((n) => n.id === 'a');
  expect([a?.liveCount, a?.factories]).toEqual([0, []]);
});

test('with no steps stored the map is empty', () => {
  const map = homeMap([workflow('manager', 'wf-manager')], SHOWN);
  expect([...map.inputs, ...map.manager, ...map.loop.steps, ...map.outputs]).toEqual([]);
});

const within = (inner: Box | undefined, outer: Box | undefined) =>
  inner !== undefined &&
  outer !== undefined &&
  inner.x >= outer.x &&
  inner.y >= outer.y &&
  inner.x + inner.width <= outer.x + outer.width &&
  inner.y + inner.height <= outer.y + outer.height;

const apart = (a: Box, b: Box) =>
  a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;

/** `b` includes a block whose step `x` includes another: two levels of include. */
const twoLevels: HomeMapRow[] = [
  step('a', 0, []),
  step('b', 1, ['a'], { kind: 'include' }),
  step('b/x', 2, [], { kind: 'include', detail_workflow: 'wf-outer', detail_path: 'x' }),
  step('b/x/y', 3, [], {
    detail_workflow: 'wf-inner',
    detail_path: 'y',
    lap_factory: 'here',
    laps: 1,
    is_current: true,
  }),
  step('b/x/z', 4, ['y'], { detail_workflow: 'wf-inner', detail_path: 'z' }),
  step('c', 5, ['b']),
];

test('an include inside an include expands too, every step inside each box around it', () => {
  const map = homeMap(twoLevels, SHOWN);
  expect(map.loop.steps.map((n) => n.id)).toEqual(['a', 'b', 'b/x', 'b/x/y', 'b/x/z', 'c']);
  expect(map.loop.clusters).toEqual(
    new Map([
      ['b', ['b/x']],
      ['b/x', ['b/x/y', 'b/x/z']],
    ]),
  );
  const laid = layoutSteps(map.loop);
  for (const id of ['b/x/y', 'b/x/z']) {
    expect([id, within(laid.nodes.get(id), laid.clusters.get('b/x'))]).toEqual([id, true]);
  }
  expect(within(laid.clusters.get('b/x'), laid.clusters.get('b'))).toBe(true);
  for (const parent of ['b', 'b/x']) {
    expect([parent, within(laid.nodes.get(parent), laid.clusters.get(parent))]).toEqual([
      parent,
      true,
    ]);
  }
  const boxes = [...laid.nodes.values()];
  for (const [i, a] of boxes.entries())
    for (const b of boxes.slice(i + 1)) expect(apart(a, b)).toBe(true);
  const spine = ['a', 'b', 'c'].map((id) => (laid.clusters.get(id) ?? laid.nodes.get(id))?.y ?? 0);
  expect(spine).toEqual([...spine].sort((p, q) => p - q));
});

test('a nested step opens under the workflow that declares it, and counts its own laps', () => {
  const map = homeMap(twoLevels, SHOWN);
  const node = (id: string) => map.loop.steps.find((n) => n.id === id);
  expect(node('b/x/y')?.href).toBe('/steps/wf-inner/y');
  expect(node('b/x')?.href).toBe('/steps/wf-outer/x');
  expect(node('b/x/y')?.liveCount).toBe(1);
  expect(node('b/x/z')?.liveCount).toBe(0);
});

test("the manager and each input show their own steps, each opening that workflow's step", () => {
  const own = (name: string, role: 'input' | 'manager', path: string, position: number) =>
    step(path, position, position === 0 ? [] : ['first'], {
      role,
      workflow: name,
      detail_workflow: name,
    });
  const map = homeMap(
    [
      ...rows,
      own('wf-manager', 'manager', 'first', 0),
      own('wf-manager', 'manager', 'second', 1),
      own('wf-writer', 'input', 'first', 0),
    ],
    SHOWN,
  );
  expect(map.inputs.map((n) => n.label)).toEqual([
    'Product document',
    'wf-writer',
    'Owner decisions',
  ]);
  expect(map.manager.map((n) => n.label)).toEqual(['wf-manager']);
  const manager = map.workflows.get('wf-manager');
  expect(manager?.steps.map((n) => [n.workflow, n.href])).toEqual([
    ['wf-manager', '/steps/wf-manager/first'],
    ['wf-manager', '/steps/wf-manager/second'],
  ]);
  expect(manager?.edges).toEqual([{ from: 'first', to: 'second' }]);
  expect(map.workflows.get('wf-writer')?.steps.map((n) => n.id)).toEqual(['first']);
  expect(map.loop.steps.map((n) => n.id)).toEqual(['a', 'b', 'b/one', 'b/two', 'c']);
});

test('the narrow layout keeps the spine in one column, each box moving with what it holds', () => {
  const { loop } = homeMap(twoLevels, SHOWN);
  const desktop = layoutSteps(loop);
  const narrow = layoutSteps(loop, true);
  const outerBox = (laid: typeof desktop, id: string) =>
    (laid.clusters.get(id) ?? laid.nodes.get(id)) as Box;
  const spine = ['a', 'b', 'c'];
  for (const id of spine) {
    const box = outerBox(narrow, id);
    const original = outerBox(desktop, id);
    expect([id, box.x, box.y, box.width, box.height]).toEqual([
      id,
      24,
      original.y,
      original.width,
      original.height,
    ]);
  }
  expect(narrow.nodes.get('a')?.x).toBe(24);
  expect((narrow.nodes.get('a')?.x ?? 0) + (narrow.nodes.get('a')?.width ?? 0)).toBeLessThanOrEqual(
    340,
  );
  const box = outerBox(desktop, 'b');
  const moved = outerBox(narrow, 'b');
  for (const id of ['b', 'b/x', 'b/x/y', 'b/x/z']) {
    const was = desktop.nodes.get(id) as Box;
    const now = narrow.nodes.get(id) as Box;
    expect([id, now.x - moved.x, now.y - moved.y]).toEqual([id, was.x - box.x, was.y - box.y]);
  }
  for (const edge of narrow.edges.filter((e) => spine.includes(e.from) && spine.includes(e.to))) {
    const from = outerBox(narrow, edge.from);
    const to = outerBox(narrow, edge.to);
    expect(edge.d).toStartWith(`M${from.x + from.width / 2},${from.y + from.height}`);
    expect(edge.d).toEndWith(`L${to.x + to.width / 2},${to.y}`);
  }
});

test('the layout places every step apart, and the box around its own step and its stages', () => {
  const longFactory = 'a-factory-with-a-long-name';
  const map = homeMap(
    [
      ...rows,
      step('b/two', 3, ['one'], { lap_factory: longFactory, laps: 123 }),
      step('b/two', 3, ['one'], { lap_factory: 'b-other', laps: 4 }),
    ],
    [...SHOWN, longFactory],
  );
  const laid = layoutSteps(map.loop);
  const plain = laid.nodes.get('b/one') as Box;
  const counted = laid.nodes.get('b/two') as Box;
  expect(counted.width).toBeGreaterThan(plain.width);
  expect(counted.height).toBeGreaterThan(plain.height);
  expect([...laid.nodes.keys()]).toEqual(map.loop.steps.map((n) => n.id));
  const boxes = [...laid.nodes.values()];
  for (const [i, a] of boxes.entries())
    for (const b of boxes.slice(i + 1)) expect(apart(a, b)).toBe(true);
  for (const id of ['b', 'b/one', 'b/two']) {
    expect([id, within(laid.nodes.get(id), laid.clusters.get('b'))]).toEqual([id, true]);
  }
  expect(laid.edges.every((e) => e.d.startsWith('M'))).toBe(true);
});

test('a step name is shown whole: one line up to 16 characters, else two split at a separator', () => {
  expect(stepLabelLines('build')).toEqual(['build']);
  expect(stepLabelLines('update-pr-body')).toEqual(['update-pr-body']);
  expect(stepLabelLines('review-completeness')).toEqual(['review-', 'completeness']);
  expect(stepLabelLines('a-much-longer-step-name')).toEqual(['a-much-longer-', 'step-name']);
  expect(stepLabelLines('averyveryverylongstepname')).toEqual(['averyveryverylongstepname']);
});

test('each step box is wide enough for its longest name line, and taller for a second line', () => {
  const names = ['build', 'update-pr-body', 'review-completeness', 'averyveryverylongstepname'];
  const map = homeMap(
    names.map((name, i) => step(name, i, i === 0 ? [] : [names[i - 1] as string])),
    SHOWN,
  );
  const laid = layoutSteps(map.loop);
  for (const name of names) {
    const box = laid.nodes.get(name) as Box;
    const lines = stepLabelLines(name);
    // 96px beside the label, 8px per 13px Geist Mono character.
    expect(box.width).toBeGreaterThanOrEqual(96 + Math.max(...lines.map((l) => l.length)) * 8);
    expect(box.height).toBe(lines.length === 1 ? 46 : 63);
  }
});
