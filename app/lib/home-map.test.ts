import { expect, test } from 'bun:test';
import {
  type Box,
  foldSteps,
  homeHref,
  stepGraph,
  type StepTreeRow,
  exclusiveOn,
  layoutSteps,
  openedBlocks,
  pinnedValues,
  reduceEdges,
  shownAs,
  stepLabelLines,
  topBlocks,
} from './home-map';

const step = (
  path: string,
  position: number,
  dependsOn: string[],
  extra: Partial<StepTreeRow> = {},
): StepTreeRow => {
  const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : null;
  return {
    workflow: 'wf-loop',
    path,
    parent_path: parent,
    position,
    step_id: path.slice(path.lastIndexOf('/') + 1),
    kind: 'script',
    depends_on: dependsOn,
    ...extra,
  };
};

// Out of order, as a live query may deliver them.
const rows: StepTreeRow[] = [
  step('c', 9, ['b']),
  step('b/two', 3, ['one']),
  step('a', 0, []),
  step('b', 1, ['a'], { kind: 'include' }),
  step('b/one', 2, []),
];

test('the loop is in declaration order, each expanded step followed by its stages', () => {
  const loop = stepGraph(rows);
  expect(loop.steps.map((n) => n.id)).toEqual(['a', 'b', 'b/one', 'b/two', 'c']);
  expect(loop.steps.map((n) => n.role)).toEqual(['step', 'step', 'stage', 'stage', 'step']);
  expect(loop.clusters).toEqual(new Map([['b', ['b/one', 'b/two']]]));
});

test("a stage's depends_on names its siblings, and a stage with none hangs off its step", () => {
  const { edges } = stepGraph(rows);
  expect(edges).toContainEqual({ from: 'b', to: 'b/one' });
  expect(edges).toContainEqual({ from: 'b/one', to: 'b/two' });
  expect(edges).not.toContainEqual({ from: 'one', to: 'b/two' });
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
  const loop = stepGraph([...rows, step('d', 10, ['a', 'c'])]);
  expect(loop.edges).toContainEqual({ from: 'c', to: 'd' });
  expect(loop.edges).not.toContainEqual({ from: 'a', to: 'd' });
});

test('every step opens its place in the loop workflow', () => {
  const loop = stepGraph(rows);
  const href = (id: string) => loop.steps.find((n) => n.id === id)?.href;
  expect(href('a')).toBe('/steps/wf-loop/a');
  expect(href('b/two')).toBe('/steps/wf-loop/b%2Ftwo');
});

test("at a version, every step opens its screen at that version; the current map's name none", () => {
  const at = '8e3e1cefaf1e1b7955789d6a43a81b6c2dbd7082';
  const hrefs = (at?: string) => stepGraph(rows, at).steps.map((n) => n.href);
  expect(hrefs(at).every((href) => href.endsWith(`?at=${at}`))).toBe(true);
  expect(hrefs().some((href) => href.includes('?at='))).toBe(false);
  expect(homeHref(null)).toBe('/');
  expect(homeHref(at)).toBe(`/?at=${at}`);
});

test('with no steps stored the graph is empty', () => {
  expect(stepGraph([])).toEqual({ steps: [], edges: [], clusters: new Map() });
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
const twoLevels: StepTreeRow[] = [
  step('a', 0, []),
  step('b', 1, ['a'], { kind: 'include' }),
  step('b/x', 2, [], { kind: 'include' }),
  step('b/x/y', 3, []),
  step('b/x/z', 4, ['y']),
  step('c', 5, ['b']),
];

test('an include inside an include expands too, every step inside each box around it', () => {
  const loop = stepGraph(twoLevels);
  expect(loop.steps.map((n) => n.id)).toEqual(['a', 'b', 'b/x', 'b/x/y', 'b/x/z', 'c']);
  expect(loop.clusters).toEqual(
    new Map([
      ['b', ['b/x']],
      ['b/x', ['b/x/y', 'b/x/z']],
    ]),
  );
  const laid = layoutSteps(loop);
  for (const id of ['b/x/y', 'b/x/z']) {
    expect([id, within(laid.nodes.get(id), laid.clusters.get('b/x'))]).toEqual([id, true]);
  }
  expect(within(laid.clusters.get('b/x'), laid.clusters.get('b'))).toBe(true);
  // The inner block's box holds its own step; the top-level block's step stays on the spine.
  expect(within(laid.nodes.get('b/x'), laid.clusters.get('b/x'))).toBe(true);
  expect(within(laid.nodes.get('b'), laid.clusters.get('b'))).toBe(false);
  const boxes = [...laid.nodes.values()];
  for (const [i, a] of boxes.entries())
    for (const b of boxes.slice(i + 1)) expect(apart(a, b)).toBe(true);
  const spine = ['a', 'b', 'c'].map((id) => laid.nodes.get(id)?.y ?? 0);
  expect(spine).toEqual([...spine].sort((p, q) => p - q));
});

test('a nested step opens its place in its own workflow', () => {
  const loop = stepGraph(twoLevels);
  const node = (id: string) => loop.steps.find((n) => n.id === id);
  expect(node('b/x/y')?.href).toBe('/steps/wf-loop/b%2Fx%2Fy');
  expect(node('b/x')?.href).toBe('/steps/wf-loop/b%2Fx');
});

test('the narrow layout keeps the spine in one column, each box beside it moving with what it holds', () => {
  const loop = stepGraph(twoLevels);
  const desktop = layoutSteps(loop);
  const narrow = layoutSteps(loop, true);
  const spine = ['a', 'b', 'c'];
  for (const id of spine) {
    const box = narrow.nodes.get(id) as Box;
    const original = desktop.nodes.get(id) as Box;
    expect([id, box.x, box.y, box.width, box.height]).toEqual([
      id,
      24,
      original.y,
      original.width,
      original.height,
    ]);
  }
  expect((narrow.nodes.get('a')?.x ?? 0) + (narrow.nodes.get('a')?.width ?? 0)).toBeLessThanOrEqual(
    340,
  );
  const box = desktop.clusters.get('b') as Box;
  const moved = narrow.clusters.get('b') as Box;
  // The box is to the right of the spine, never over it.
  const right = Math.max(
    ...spine.map((id) => (narrow.nodes.get(id) as Box).x + (narrow.nodes.get(id) as Box).width),
  );
  expect(moved.x).toBeGreaterThan(right);
  expect(narrow.width).toBeGreaterThanOrEqual(moved.x + moved.width);
  for (const id of ['b/x', 'b/x/y', 'b/x/z']) {
    const was = desktop.nodes.get(id) as Box;
    const now = narrow.nodes.get(id) as Box;
    expect([id, now.x - moved.x, now.y - moved.y]).toEqual([id, was.x - box.x, was.y - box.y]);
  }
  for (const edge of narrow.edges.filter((e) => spine.includes(e.from) && spine.includes(e.to))) {
    const from = narrow.nodes.get(edge.from) as Box;
    const to = narrow.nodes.get(edge.to) as Box;
    expect(edge.d).toStartWith(`M${from.x + from.width / 2},${from.y + from.height}`);
    expect(edge.d).toEndWith(`L${to.x + to.width / 2},${to.y}`);
  }
});

test('the layout places every step apart, and the box around the stages beside their step', () => {
  const loop = stepGraph(rows);
  const laid = layoutSteps(loop);
  expect([...laid.nodes.keys()]).toEqual(loop.steps.map((n) => n.id));
  const boxes = [...laid.nodes.values()];
  for (const [i, a] of boxes.entries())
    for (const b of boxes.slice(i + 1)) expect(apart(a, b)).toBe(true);
  for (const id of ['b/one', 'b/two']) {
    expect([id, within(laid.nodes.get(id), laid.clusters.get('b'))]).toEqual([id, true]);
  }
  expect(within(laid.nodes.get('b'), laid.clusters.get('b'))).toBe(false);
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
  const loop = stepGraph(
    names.map((name, i) => step(name, i, i === 0 ? [] : [names[i - 1] as string])),
  );
  const laid = layoutSteps(loop);
  for (const name of names) {
    const box = laid.nodes.get(name) as Box;
    const lines = stepLabelLines(name);
    // 96px beside the label, 8px per 13px Geist Mono character.
    expect(box.width).toBeGreaterThanOrEqual(96 + Math.max(...lines.map((l) => l.length)) * 8);
    expect(box.height).toBe(lines.length === 1 ? 46 : 63);
  }
});

test('each block opens folded: one box with its step count, its steps hidden in order', () => {
  const nested: StepTreeRow[] = [
    step('a', 0, []),
    step('b', 1, ['a'], { kind: 'include' }),
    step('b/one', 2, []),
    step('b/two', 3, ['one'], { kind: 'include' }),
    step('b/two/x', 4, []),
    step('c', 5, ['b']),
  ];
  const loop = stepGraph(nested);
  const folded = foldSteps(loop, new Set());
  expect(folded.graph.steps.map((s) => s.id)).toEqual(['a', 'b', 'c']);
  expect(folded.graph.edges).toEqual([
    { from: 'a', to: 'b' },
    { from: 'b', to: 'c' },
  ]);
  const b = folded.graph.steps.find((s) => s.id === 'b');
  expect(b?.folded).toEqual({ steps: 3, notes: ['3 steps'] });
  expect(folded.hidden.map((s) => s.id)).toEqual(['b/one', 'b/two', 'b/two/x']);
  expect(shownAs(folded.folded, 'b/two/x')).toBe('b');
  // Opened, b shows its own steps; the block inside it stays folded until opened in turn.
  const open = foldSteps(loop, new Set(['b']));
  expect(open.graph.steps.map((s) => s.id)).toEqual(['a', 'b', 'b/one', 'b/two', 'c']);
  expect([...open.folded]).toEqual([['b/two', 1]]);
  expect(shownAs(open.folded, 'b/two/x')).toBe('b/two');
  // A folded box is taller for its note and fits it.
  const plain = layoutSteps(loop).nodes.get('a') as Box;
  const box = layoutSteps(folded.graph).nodes.get('b') as Box;
  expect(box.height).toBeGreaterThan(plain.height);
  expect(layoutSteps(folded.graph).height).toBeLessThan(layoutSteps(loop).height);
});

test('a when pins a variable to the values every branch of it names', () => {
  expect(
    pinnedValues(
      "$c.output.held == 'true' && $p.output.route == 'continue' || $c.output.held == 'true' && $p.output.route == 'simple'",
    ),
  ).toEqual(
    new Map([
      ['$c.output.held', ['true']],
      ['$p.output.route', ['continue', 'simple']],
    ]),
  );
  expect(pinnedValues("$p.output.route != 'none'")).toEqual(new Map());
  expect(pinnedValues(null)).toEqual(new Map());
  expect(exclusiveOn("$p.output.route == 'simple'", "$p.output.route == 'complex'")).toEqual({
    on: '$p.output.route',
    a: ['simple'],
    b: ['complex'],
  });
  expect(exclusiveOn("$p.output.route == 'simple'", "$p.output.route == 'simple'")).toBeNull();
  expect(exclusiveOn('$x.output.n > 0', "$p.output.route == 'complex'")).toBeNull();
});

// The loop's route split: build on simple or continue, ship on complex, waiting on build only for
// order, both joining at subject.
const fork: StepTreeRow[] = [
  step('claim', 0, []),
  step('build', 1, ['claim'], {
    when_condition: "$pick.output.route == 'simple' || $pick.output.route == 'continue'",
  }),
  step('ship', 2, ['claim', 'build'], {
    kind: 'include',
    trigger_rule: 'none_failed_min_one_success',
    when_condition: "$pick.output.route == 'complex'",
  }),
  step('ship/forge', 3, []),
  step('ship/report', 4, ['forge']),
  step('subject', 5, ['claim', 'build', 'ship'], { trigger_rule: 'all_done' }),
];

test('a route fork is drawn side by side, each edge into it labelled, rejoining after', () => {
  const loop = stepGraph(fork);
  expect(loop.edges).toEqual([
    { from: 'claim', to: 'build', label: 'simple / continue' },
    { from: 'claim', to: 'ship', label: 'complex' },
    { from: 'ship', to: 'ship/forge' },
    { from: 'ship/forge', to: 'ship/report' },
    { from: 'build', to: 'subject' },
    { from: 'ship', to: 'subject' },
  ]);
  // Without the trigger rule that lets ship run past a skipped build, the edge is a real order.
  const ordered = stepGraph(
    fork.map((r) => (r.path === 'ship' ? { ...r, trigger_rule: null } : r)),
  );
  expect(ordered.edges).toContainEqual({ from: 'build', to: 'ship' });
  expect(ordered.edges.some((e) => e.label !== undefined)).toBe(false);
});

test("an open top-level block's steps sit in a box beside its step, and what follows leaves its end", () => {
  const loop = stepGraph(fork);
  expect(topBlocks(loop)).toEqual(['ship']);
  const laid = layoutSteps(foldSteps(loop, new Set(topBlocks(loop))).graph);
  const box = laid.clusters.get('ship') as Box;
  for (const id of ['ship/forge', 'ship/report']) {
    expect([id, within(laid.nodes.get(id), box)]).toEqual([id, true]);
  }
  expect(within(laid.nodes.get('ship'), box)).toBe(false);
  const ship = laid.nodes.get('ship') as Box;
  const build = laid.nodes.get('build') as Box;
  // The two sides of the fork stand side by side, on the same row, under claim.
  expect(ship.y).toBe(build.y);
  expect(apart(ship, build)).toBe(true);
  expect(laid.edges.map((e) => `${e.from}>${e.to}`)).toContain('ship/report>subject');
  expect(laid.edges.map((e) => `${e.from}>${e.to}`)).not.toContain('ship>subject');
  for (const e of laid.edges.filter((e) => e.label !== undefined)) {
    expect([e.to, e.labelAt === undefined]).toEqual([e.to, false]);
  }
});

test('the blocks shown open are the defaults the viewer has not folded, and each one opened', () => {
  expect([...openedBlocks(['ship', 'deploy'], new Map())]).toEqual(['ship', 'deploy']);
  expect([
    ...openedBlocks(
      ['ship', 'deploy'],
      new Map([
        ['ship', false],
        ['ship/deliver', true],
      ]),
    ),
  ]).toEqual(['deploy', 'ship/deliver']);
});
