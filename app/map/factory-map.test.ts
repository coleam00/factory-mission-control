import { expect, test } from 'bun:test';
import { MAP_TYPE } from '../components/FactoryMap';
import {
  cardWidth,
  FACTORY_MAP,
  FIT_FOOT,
  FIT_MAX,
  FIT_PAD,
  fitScale,
  heroFrameHeight,
  levelMax,
  linePoints,
  type MapView,
  MIN_FRAME,
  mapOrigin,
  midpoint,
  neighbours,
  pinnedStepLinks,
  stepLinks,
  tourPoints,
  viewPath,
  viewSearch,
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

const levels: MapView[] = [FACTORY_MAP, ...Object.values(FACTORY_MAP.views ?? {})];

test('every line, the tour and the legend name cards and roles the map has, at every level', () => {
  const all = levels.flatMap((level) => level.cards);
  expect(new Set(all.map((c) => c.id)).size).toBe(all.length);
  for (const level of levels) {
    const ids = new Set(level.cards.map((c) => c.id));
    for (const l of level.lines) expect([l.from, l.to].filter((id) => !ids.has(id))).toEqual([]);
    expect(level.tour.filter((id) => !ids.has(id))).toEqual([]);
  }
  expect(new Set(FACTORY_MAP.legend.map((l) => l.role))).toEqual(new Set(all.map((c) => c.role)));
});

test('viewPath resolves ?view to its path; unknown, empty and null go to the root', () => {
  expect(viewPath(FACTORY_MAP, 'build')).toEqual(['build']);
  for (const id of ['nope', '', null]) expect(viewPath(FACTORY_MAP, id)).toEqual([]);
});

test('Review opened from Deliver keeps the Build and Deliver path through the address', () => {
  const deliver = ['build', 'build/deliver'];
  expect(viewPath(FACTORY_MAP, 'review')).toEqual(['review']);
  expect(viewPath(FACTORY_MAP, 'review', 'build/deliver')).toEqual([...deliver, 'review']);
  expect(viewPath(FACTORY_MAP, 'review', 'split')).toEqual(['review']);
  const search = viewSearch(FACTORY_MAP, new URLSearchParams(), [...deliver, 'review']);
  expect(search.toString()).toBe('view=review&from=build%2Fdeliver');
  expect(viewSearch(FACTORY_MAP, search, deliver).toString()).toBe('view=build%2Fdeliver');
  expect(viewSearch(FACTORY_MAP, new URLSearchParams(), ['review']).toString()).toBe('view=review');
});

test('viewSearch sets or deletes view and keeps the other parameters', () => {
  const prev = new URLSearchParams('at=abc');
  expect(viewSearch(FACTORY_MAP, prev, ['build']).toString()).toBe('at=abc&view=build');
  expect(viewSearch(FACTORY_MAP, new URLSearchParams('at=abc&view=build'), []).toString()).toBe(
    'at=abc',
  );
});

test('the Build view fitted at 1440 in the home frame keeps the card type at or above its floors', () => {
  const view = FACTORY_MAP.views?.build as MapView;
  const world = worldSize(view);
  const frame = heroFrameHeight(worldSize(FACTORY_MAP), 1384);
  const k = Math.min(
    (1384 - FIT_PAD * 2) / world.width,
    (frame - FIT_PAD * 2 - FIT_FOOT) / world.height,
    1.15,
  );
  expect(k * MAP_TYPE.title).toBeGreaterThanOrEqual(14);
  expect(k * MAP_TYPE.text).toBeGreaterThanOrEqual(11);
  expect(k * MAP_TYPE.label).toBeGreaterThanOrEqual(10);
});

test("a line joins its cards' sides, turning halfway across when they are not level", () => {
  expect(linePoints(FACTORY_MAP, line('prd', 'intake'))).toEqual([
    [208, 388],
    [234, 388],
    [234, 648],
    [260, 648],
  ]);
  expect(linePoints(FACTORY_MAP, line('mgr', 'review'))).toEqual([
    [1311, 212],
    [1311, 492],
  ]);
  expect(linePoints(FACTORY_MAP, line('intake', 'split'))).toEqual([
    [322, 542],
    [322, 452],
  ]);
});

test("a label sits halfway along its line's length", () => {
  expect(midpoint(linePoints(FACTORY_MAP, line('build', 'review')))).toEqual([1046, 648]);
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
  expect(points[0]).toEqual([104, 388]);
  expect(points.at(-1)).toEqual([2248, 648]);
  for (const [i, [x, y]] of points.slice(1).entries()) {
    const [px, py] = points[i] as [number, number];
    expect(x === px || y === py).toBe(true);
  }
});

test("a card's neighbours are the cards a line joins to it", () => {
  expect([...neighbours(FACTORY_MAP, 'build')].sort()).toEqual(['app', 'merge', 'order', 'review']);
  expect([...neighbours(FACTORY_MAP, 'app')].sort()).toEqual(['build', 'disc', 'merge', 'review']);
  expect([...neighbours(FACTORY_MAP, 'intake')].sort()).toEqual([
    'disc',
    'issue',
    'order',
    'prd',
    'split',
  ]);
  expect(neighbours(FACTORY_MAP, null).size).toBe(0);
});

test("the fixes line runs from Review's top to Build's top and App check and Merge join it, arrowless", () => {
  const top = (id: string): [number, number] => {
    const c = card(id);
    return [c.x + FACTORY_MAP.cardSize.width / 2, c.y];
  };
  const fixes = line('review', 'build');
  const joins = [line('app', 'build'), line('merge', 'build')];
  const rail = linePoints(FACTORY_MAP, fixes);
  expect([fixes, ...joins].map((l) => l.style)).toEqual(['loop', 'loop', 'loop']);
  expect(fixes.label).toBe('fixes');
  expect(fixes.arrow).not.toBe(false);
  expect(rail[0]).toEqual(top('review'));
  expect(rail.at(-1)).toEqual(top('build'));
  const railY = (rail[1] as [number, number])[1];
  expect(railY).toBeLessThan(card('review').y);
  expect(railY).toBeGreaterThan(FACTORY_MAP.group.y);
  for (const [i, join] of joins.entries()) {
    const points = linePoints(FACTORY_MAP, join);
    expect(join.arrow).toBe(false);
    expect(points[0]).toEqual(top(['app', 'merge'][i] as string));
    expect(points.at(-1)).toEqual([top('review')[0], railY]);
  }
});

test('the world holds every card, the group box and the routed lines, with margin', () => {
  expect(worldSize(FACTORY_MAP)).toEqual({ width: 2394, height: 1084 });
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

test("App check's steps open their screens, check-app's among them; Review's open their places", () => {
  const hrefs = (id: string, at: string | null) => stepLinks(card(id), 'x', at).map((l) => l.href);
  expect(hrefs('app', null).slice(0, 3)).toEqual([
    '/f/x/steps/archon-loop/briefs',
    '/f/x/steps/archon-loop/check-app',
    '/f/x/steps/archon-loop/evidence',
  ]);
  expect(hrefs('app', null)).toContain('/f/x/steps/factory-app-check/check');
  expect(hrefs('review', 'abc')).toContain(
    '/f/x/steps/archon-loop/ship%2Fdeliver%2Frounds%2Freview?at=abc',
  );
  expect(hrefs('review', 'abc')).toContain(
    '/f/x/steps/archon-build-queue/ship%2Fdeliver%2Frounds%2Frereview?at=abc',
  );
});

test('a version with only the old loop lists each review round once, not once per pack', () => {
  const row = (workflow: string, path: string, kind: string, include: string | null = null) =>
    ({ workflow, path, kind, include, model: null }) as unknown as Parameters<
      typeof pinnedStepLinks
    >[3][number];
  const old = [
    row('archon-loop', 'ship', 'include', 'a'),
    row('a', 'deliver', 'include', 'b'),
    row('b', 'rounds', 'loop_group'),
    row('b', 'rounds/review', 'agent'),
    row('b', 'rounds/rereview', 'agent'),
  ];
  const links = pinnedStepLinks(card('review'), 'x', 'abc', old);
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

test('at the 1440 hero width the fitted scale keeps the card type at or above its floors', () => {
  const k = (1384 - FIT_PAD * 2) / worldSize(FACTORY_MAP).width;
  expect(k * MAP_TYPE.title).toBeGreaterThanOrEqual(14);
  expect(k * MAP_TYPE.text).toBeGreaterThanOrEqual(11);
  expect(k * MAP_TYPE.label).toBeGreaterThanOrEqual(10);
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

test('no two cards overlap at any level, and the Work order view joins its sources in one arrow', () => {
  for (const level of levels) {
    const { height } = level.cardSize;
    for (const [i, a] of level.cards.entries()) {
      for (const b of level.cards.slice(i + 1)) {
        const apart =
          a.x + cardWidth(level, a) <= b.x ||
          b.x + cardWidth(level, b) <= a.x ||
          a.y + height <= b.y ||
          b.y + height <= a.y;
        expect([a.id, b.id, apart]).toEqual([a.id, b.id, true]);
      }
    }
  }
  const order = FACTORY_MAP.views?.order as MapView;
  const into = order.lines.filter((l) => l.to === 'o-pick');
  expect(into).toHaveLength(3);
  expect(into.filter((l) => l.arrow !== false)).toHaveLength(1);
});

const hero = (width: number) => ({
  width,
  height: heroFrameHeight(worldSize(FACTORY_MAP), width),
});
const view = (id: string) => FACTORY_MAP.views?.[id] as MapView;
const FEW_CARDS = ['deploy', 'merge', 'split', 'order', 'manager'];

const MATCHING = ['intake', 'review', 'app', 'build', 'build/deliver'];

test('a deeper view with few cards is fitted no larger than the matching views at 1440', () => {
  const frame = hero(1384);
  const largest = Math.max(...MATCHING.map((id) => fitScale(worldSize(view(id)), frame)));
  expect(largest).toBeGreaterThan(0.65);
  expect(largest).toBeLessThan(0.76);
  for (const id of FEW_CARDS) {
    const v = view(id);
    expect(fitScale(worldSize(v), frame, levelMax(FACTORY_MAP, v, frame))).toBeLessThanOrEqual(
      largest,
    );
  }
});

test('the views that matched their references keep their fit at every hero width', () => {
  for (const id of MATCHING) {
    const v = view(id);
    for (let width = 701; width <= 2560; width += 7) {
      const frame = hero(width);
      const world = worldSize(v);
      expect(fitScale(world, frame, levelMax(FACTORY_MAP, v, frame))).toBe(fitScale(world, frame));
    }
  }
  expect(levelMax(FACTORY_MAP, FACTORY_MAP, hero(1384))).toBe(FIT_MAX);
});

test('no kind label wraps in the Staging, Merge, Split, Work order and Manager views', () => {
  // Geist Mono advances 0.6em plus tracking-[0.06em]; MapCard adds pl-4 pr-3 and a 2px border each side.
  for (const id of FEW_CARDS) {
    const v = view(id);
    for (const c of v.cards) {
      expect(c.kind.length * MAP_TYPE.kind * 0.66 + 32).toBeLessThanOrEqual(cardWidth(v, c));
    }
  }
});

test("every level's tour stays on its drawn lines", () => {
  const levels = [FACTORY_MAP, ...Object.values(FACTORY_MAP.views ?? {})] as MapView[];
  for (const level of levels.filter((l) => l.tour.length > 1)) {
    const polylines = level.lines.map((l) => linePoints(level, l));
    const onLine = (x: number, y: number) =>
      polylines.some((pts) =>
        pts.slice(1).some(([x2, y2], i) => {
          const [x1, y1] = pts[i] as [number, number];
          const len2 = (x2 - x1) ** 2 + (y2 - y1) ** 2;
          const t =
            len2 === 0
              ? 0
              : Math.max(0, Math.min(1, ((x - x1) * (x2 - x1) + (y - y1) * (y2 - y1)) / len2));
          return Math.hypot(x - (x1 + t * (x2 - x1)), y - (y1 + t * (y2 - y1))) <= 0.5;
        }),
      );
    const underCard = (x: number, y: number) =>
      level.cards.some(
        (c) =>
          x >= c.x &&
          x <= c.x + cardWidth(level, c) &&
          y >= c.y &&
          y <= c.y + level.cardSize.height,
      );
    const pts = tourPoints(level);
    for (let i = 1; i < pts.length; i++) {
      const [x1, y1] = pts[i - 1] as [number, number];
      const [x2, y2] = pts[i] as [number, number];
      for (let s = 0; s <= 50; s++) {
        const x = x1 + ((x2 - x1) * s) / 50;
        const y = y1 + ((y2 - y1) * s) / 50;
        expect(underCard(x, y) || onLine(x, y)).toBe(true);
      }
    }
  }
});

test("the Manager's two asks share one trunk", () => {
  const m = view('manager');
  const pts = (to: string) =>
    linePoints(m, m.lines.find((l) => l.from === 'u-mgr' && l.to === to) as never);
  const [b, mg] = [pts('u-b'), pts('u-m')];
  expect(b.slice(0, 2)).toEqual(mg.slice(0, 2));
  expect(
    m.lines.filter((l) => l.from === 'u-mgr' && l.arrow !== false && l.style === 'ask'),
  ).toHaveLength(1);
  for (const [to, p] of [
    ['u-b', b],
    ['u-m', mg],
  ] as const) {
    const c = m.cards.find((x) => x.id === to) as (typeof m.cards)[number];
    expect(p.at(-1)).toEqual([c.x + cardWidth(m, c) / 2, c.y + m.cardSize.height]);
  }
});

test("a step's default origin is the map at the view of its deepest card, that card selected", () => {
  const app = mapOrigin(FACTORY_MAP, 'x', 'factory-app-check', 'check', null);
  expect(app.href).toBe('/f/x?view=app');
  expect(app.card).toBe('a-check');
  expect(mapOrigin(FACTORY_MAP, 'x', 'factory-app-check', 'check', 'abc').href).toBe(
    '/f/x?at=abc&view=app',
  );
  expect(mapOrigin(FACTORY_MAP, 'x', 'archon-implement', 'implement', null)).toEqual({
    href: '/f/x',
    label: 'Factory',
  });
});
