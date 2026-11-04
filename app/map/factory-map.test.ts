import { expect, test } from 'bun:test';
import {
  FACTORY_MAP,
  FIT_FOOT,
  FIT_PAD,
  heroFrameHeight,
  linePoints,
  MIN_FRAME,
  midpoint,
  neighbours,
  pinnedStepLinks,
  stepLinks,
  tourPoints,
  worldSize,
} from './factory-map';

const line = (from: string, to: string) => {
  const found = FACTORY_MAP.lines.find((l) => l.from === from && l.to === to);
  if (found === undefined) throw new Error(`no line ${from} -> ${to}`);
  return found;
};
const card = (id: string) => {
  const found = FACTORY_MAP.cards.find((c) => c.id === id);
  if (found === undefined) throw new Error(`no card ${id}`);
  return found;
};

test('every line, the tour and the legend name cards and roles the map has', () => {
  const ids = new Set(FACTORY_MAP.cards.map((c) => c.id));
  expect(ids.size).toBe(FACTORY_MAP.cards.length);
  for (const l of FACTORY_MAP.lines)
    expect([l.from, l.to].filter((id) => !ids.has(id))).toEqual([]);
  expect(FACTORY_MAP.tour.filter((id) => !ids.has(id))).toEqual([]);
  expect(new Set(FACTORY_MAP.legend.map((l) => l.role))).toEqual(
    new Set(FACTORY_MAP.cards.map((c) => c.role)),
  );
});

test("a line joins its cards' sides, turning halfway across when they are not level", () => {
  expect(linePoints(FACTORY_MAP, line('prd', 'intake'))).toEqual([
    [468, 388],
    [494, 388],
    [494, 648],
    [520, 648],
  ]);
  expect(linePoints(FACTORY_MAP, line('mgr', 'review'))).toEqual([
    [1571, 212],
    [1571, 492],
  ]);
  expect(linePoints(FACTORY_MAP, line('intake', 'split'))).toEqual([
    [582, 542],
    [582, 452],
  ]);
});

test("a label sits halfway along its line's length", () => {
  expect(midpoint(linePoints(FACTORY_MAP, line('build', 'review')))).toEqual([1306, 648]);
  expect(
    midpoint([
      [0, 0],
      [0, 10],
      [30, 10],
    ]),
  ).toEqual([10, 10]);
});

test('the tour runs card centre to card centre along the line, Product document to Shipped', () => {
  const points = tourPoints(FACTORY_MAP);
  expect(points[0]).toEqual([364, 388]);
  expect(points.at(-1)).toEqual([2508, 648]);
  for (const [i, [x, y]] of points.slice(1).entries()) {
    const [px, py] = points[i] as [number, number];
    expect(x === px || y === py).toBe(true);
  }
});

test("a card's neighbours are the cards a line joins to it", () => {
  expect([...neighbours(FACTORY_MAP, 'build')].sort()).toEqual(['order', 'review']);
  expect([...neighbours(FACTORY_MAP, 'app')].sort()).toEqual(['disc', 'merge', 'review']);
  expect([...neighbours(FACTORY_MAP, 'intake')].sort()).toEqual([
    'disc',
    'issue',
    'order',
    'prd',
    'split',
  ]);
  expect(neighbours(FACTORY_MAP, null).size).toBe(0);
});

test('the world holds every card, the group box and the routed lines, with margin', () => {
  expect(worldSize(FACTORY_MAP)).toEqual({ width: 2654, height: 1084 });
  expect(card('mgr').width).toBe(478);
});

test("the owner's tighter pitch: 52 between cards, 84 where the ready and passed labels sit", () => {
  const line = ['intake', 'order', 'build', 'review', 'app', 'merge', 'deploy', 'out'].map(card);
  const gaps = line.slice(1).map((c, i) => {
    const before = line[i] as (typeof line)[number];
    return c.x - before.x - FACTORY_MAP.cardSize.width;
  });
  expect(gaps).toEqual([84, 52, 52, 52, 84, 52, 52]);
});

test("App check's steps open their screens, check-app's among them; a nested one opens under the workflow that declares it", () => {
  const hrefs = (id: string, at: string | null) => stepLinks(card(id), at).map((l) => l.href);
  expect(hrefs('app', null).slice(0, 4)).toEqual([
    '/steps/archon-loop/briefs',
    '/steps/archon-loop/check-app',
    '/steps/archon-loop/evidence',
    '/steps/archon-loop/handoff',
  ]);
  expect(hrefs('app', null)).toContain('/steps/factory-app-check/check');
  expect(hrefs('review', 'abc')).toContain('/steps/archon-deliver-block/rounds%2Freview?at=abc');
  expect(hrefs('review', 'abc')).toContain('/steps/archon-deliver-block/rounds%2Frereview?at=abc');
});

test('a version with only the old loop lists each review round once, not once per pack', () => {
  const row = (workflow: string, path: string) =>
    ({ workflow, path, model: null }) as unknown as Parameters<typeof pinnedStepLinks>[2][number];
  const old = [
    row('archon-loop', 'ship'),
    row('archon-deliver-block', 'rounds/review'),
    row('archon-deliver-block', 'rounds/rereview'),
  ];
  const links = pinnedStepLinks(card('review'), 'abc', old);
  expect(links.map((l) => `${l.workflow} ${l.step}`)).toEqual([
    'archon-loop ship/deliver/rounds/review',
    'archon-loop ship/deliver/rounds/rereview',
  ]);
});

test('the hero frame is the map at the width-fitting scale plus padding, at least 420 high', () => {
  const world = worldSize(FACTORY_MAP);
  const at = (width: number) => (width - FIT_PAD * 2) / world.width;
  expect(heroFrameHeight(world, 1384)).toBe(
    Math.max(
      MIN_FRAME,
      Math.ceil(world.height * Math.min(at(1384), 1.15) + FIT_PAD * 2 + FIT_FOOT),
    ),
  );
  expect(heroFrameHeight(world, 1384)).toBeGreaterThan(MIN_FRAME);
  expect(heroFrameHeight(world, 701)).toBe(MIN_FRAME);
  expect(heroFrameHeight(world, 5000)).toBe(
    Math.ceil(world.height * 1.15 + FIT_PAD * 2 + FIT_FOOT),
  );
});

test('Split sits above Intake, the Work order on the line between Intake and Build, and the map says no ticket or holdout', () => {
  const [intake, split, order, build] = ['intake', 'split', 'order', 'build'].map(card);
  expect(split?.x).toBe(intake?.x);
  expect(split?.y).toBeLessThan(FACTORY_MAP.group.y);
  expect(order?.y).toBe(intake?.y);
  expect(order?.x).toBeGreaterThan(intake?.x as number);
  expect(order?.x).toBeLessThan(build?.x as number);
  expect(JSON.stringify(FACTORY_MAP)).not.toMatch(/ticket|holdout/i);
});
