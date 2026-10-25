import { expect, test } from 'bun:test';
import { type HomeMapRow, homeMap, layoutLoop, reduceEdges } from './home-map';

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
  live_count: 0,
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
    live_count: 0,
    ...extra,
  };
};

// Out of order, as a live query may deliver them.
const rows: HomeMapRow[] = [
  step('c', 9, ['b']),
  workflow('manager', 'wf-manager'),
  step('b/two', 3, ['one'], { live_count: 2 }),
  step('a', 0, []),
  workflow('input', 'wf-writer'),
  step('b', 1, ['a'], { kind: 'include' }),
  step('b/one', 2, []),
];

test('the loop is in declaration order, each expanded step followed by its stages', () => {
  const map = homeMap(rows);
  expect(map.loop.map((n) => n.id)).toEqual(['a', 'b', 'b/one', 'b/two', 'c']);
  expect(map.loop.map((n) => n.role)).toEqual(['step', 'step', 'stage', 'stage', 'step']);
  expect(map.clusters).toEqual(new Map([['b', ['b/one', 'b/two']]]));
});

test("a stage's depends_on names its siblings, and a stage with none hangs off its step", () => {
  const { edges } = homeMap(rows);
  expect(edges).toContainEqual({ from: 'b', to: 'b/one' });
  expect(edges).toContainEqual({ from: 'b/one', to: 'b/two' });
  expect(edges).not.toContainEqual({ from: 'one', to: 'b/two' });
});

test('inputs, the manager and the outputs frame the loop', () => {
  const map = homeMap(rows);
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
  const map = homeMap([...rows, step('d', 10, ['a', 'c'])]);
  expect(map.edges).toContainEqual({ from: 'c', to: 'd' });
  expect(map.edges).not.toContainEqual({ from: 'a', to: 'd' });
});

test('a step links to its own workflow, a stage to the workflow its step includes', () => {
  const map = homeMap(rows);
  const href = (id: string) => map.loop.find((n) => n.id === id)?.href;
  expect(href('a')).toBe('/steps/wf-loop/a');
  expect(href('b/two')).toBe('/steps/wf-block/two');
  expect(map.loop.find((n) => n.id === 'b/two')?.liveCount).toBe(2);
});

test('with no steps stored the map is empty', () => {
  const map = homeMap([workflow('manager', 'wf-manager')]);
  expect([...map.inputs, ...map.manager, ...map.loop, ...map.outputs]).toEqual([]);
});

test('the layout places every step apart, and the stage box around its stages', () => {
  const map = homeMap(rows);
  const laid = layoutLoop(map);
  expect([...laid.nodes.keys()]).toEqual(map.loop.map((n) => n.id));
  const boxes = [...laid.nodes.values()];
  for (const [i, a] of boxes.entries()) {
    for (const b of boxes.slice(i + 1)) {
      const apart =
        a.x + a.width <= b.x ||
        b.x + b.width <= a.x ||
        a.y + a.height <= b.y ||
        b.y + b.height <= a.y;
      expect(apart).toBe(true);
    }
  }
  const cluster = laid.clusters.get('b');
  for (const id of ['b/one', 'b/two']) {
    const box = laid.nodes.get(id);
    expect(box && cluster && box.x >= cluster.x && box.y >= cluster.y).toBe(true);
  }
  expect(laid.edges.every((e) => e.d.startsWith('M'))).toBe(true);
});
