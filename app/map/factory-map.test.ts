import { expect, test } from 'bun:test';
import {
  FACTORY_MAP,
  linePoints,
  midpoint,
  neighbours,
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
  expect(linePoints(FACTORY_MAP, line('prd', 'plan'))).toEqual([
    [196, 46],
    [280, 46],
  ]);
  expect(linePoints(FACTORY_MAP, line('plan', 'hold'))).toEqual([
    [476, 46],
    [518, 46],
    [518, 176],
    [560, 176],
  ]);
  expect(linePoints(FACTORY_MAP, line('mgr', 'merge'))).toEqual([
    [1530, 92],
    [1530, 250],
  ]);
});

test("a label sits halfway along its line's length", () => {
  expect(midpoint(linePoints(FACTORY_MAP, line('build', 'review')))).toEqual([1078, 346]);
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
  expect(points[0]).toEqual([98, 46]);
  expect(points.at(-1)).toEqual([2338, 346]);
  for (const [i, [x, y]] of points.slice(1).entries()) {
    const [px, py] = points[i] as [number, number];
    expect(x === px || y === py).toBe(true);
  }
});

test("a card's neighbours are the cards a line joins to it", () => {
  expect([...neighbours(FACTORY_MAP, 'build')].sort()).toEqual(['intake', 'review']);
  expect([...neighbours(FACTORY_MAP, 'app')].sort()).toEqual(['disc', 'hold', 'merge', 'review']);
  expect(neighbours(FACTORY_MAP, null).size).toBe(0);
});

test('the world holds every card with margin', () => {
  expect(worldSize(FACTORY_MAP)).toEqual({ width: 2476, height: 680 });
  expect(card('mgr').width).toBe(520);
});

test("App check's steps open their screens, check-app's among them; a nested one opens under the workflow that declares it", () => {
  expect(stepLinks(card('app'), null).map((l) => l.href)).toEqual([
    '/steps/archon-loop/briefs',
    '/steps/archon-loop/check-app',
    '/steps/archon-loop/evidence',
  ]);
  expect(stepLinks(card('review'), 'abc').map((l) => l.href)).toEqual([
    '/steps/archon-deliver-block/rounds%2Freview?at=abc',
    '/steps/archon-deliver-block/rounds%2Frereview?at=abc',
  ]);
});
