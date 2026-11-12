import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { openPage, type Page } from '../../scripts/lib/cdp';

interface Shown {
  view: string | null;
  search: string | null;
  selected: string | null;
  flashed: (string | undefined)[];
}

let page: Page;
let source: string;

beforeAll(async () => {
  const bundle = await Bun.build({
    entrypoints: [`${import.meta.dir}/fixtures/render-map.tsx`],
    target: 'browser',
    format: 'esm',
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  expect(bundle.success).toBe(true);
  source = Buffer.from(await bundle.outputs[0].text()).toString('base64');
  page = await openPage(process.env);
}, 90_000);

afterAll(async () => {
  await page?.close();
});

/** Runs `body` in the page with the fixture's exports as `m`; every step waits on the page. */
const inPage = <T>(body: string) =>
  page.evaluate<T>(
    `import('data:text/javascript;base64,${source}').then(async (m) => { ${body} })`,
  );

const opens = (how: string) =>
  inPage<Shown[]>(`
    const out = [await m.mount('/f/x')];
    ${how}
    out.push(await m.waitFor('build'));
    return out;`);

test('a double-click, Enter on the selected card and the Open button each open the Build view', async () => {
  for (const how of [
    "m.dblclick('build');",
    "m.click('[data-card=\"build\"]'); await new Promise((r) => setTimeout(r, 50)); m.enter('build');",
    "m.click('[data-card=\"build\"]'); await new Promise((r) => setTimeout(r, 50)); m.click('[data-open-view]');",
  ]) {
    const [home, view] = await opens(how);
    expect(home?.view).toBe('root');
    expect(view).toMatchObject({ view: 'build', search: '?view=build' });
  }
}, 30_000);

test('a crumb, the up control, Esc, Backspace and the back button each go up, and Build flashes', async () => {
  for (const how of [
    'm.click(\'[data-crumb="root"]\');',
    "m.click('[data-map-up]');",
    "m.key('Escape');",
    "m.key('Backspace');",
    'await m.back();',
  ]) {
    const [after] = await inPage<Shown[]>(`
      await m.mount('/f/x');
      m.dblclick('build');
      await m.waitFor('build');
      ${how}
      await m.waitFor('root');
      return [await m.waitFlash('build')];`);
    expect(after).toMatchObject({ view: 'root', search: '' });
    expect(after?.flashed).toContain('build');
  }
}, 60_000);

test('a link to ?view=build opens the view; Merge queue goes up and selects Merge', async () => {
  const [linked, up] = await inPage<Shown[]>(`
    const linked = await m.mount('/f/x?view=build');
    m.click('[data-card="b-next"]');
    await m.waitFor('root');
    return [linked, await m.waitFlash('merge')];`);
  expect(linked).toMatchObject({ view: 'build', search: '?view=build' });
  expect(up).toMatchObject({ view: 'root', selected: 'merge' });
}, 30_000);

test('Esc and Backspace deselect a selected card first, and go up only when nothing is selected', async () => {
  for (const name of ['Escape', 'Backspace']) {
    const [first, second] = await inPage<Shown[]>(`
      await m.mount('/f/x?view=build');
      m.click('[data-card="b-del"]');
      await new Promise((r) => setTimeout(r, 50));
      m.key('${name}');
      await new Promise((r) => setTimeout(r, 50));
      const first = m.state();
      m.key('${name}');
      return [first, await m.waitFor('root')];`);
    expect(first).toMatchObject({ view: 'build', selected: null });
    expect(second).toMatchObject({ view: 'root' });
  }
}, 30_000);

test('going up within the swap window refits the home map', async () => {
  const [interrupted, mounted] = await inPage<string[]>(`
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const camera = () => document.querySelector('[data-map-world]').style.transform;
    await m.mount('/f/x');
    m.dblclick('build');
    await sleep(100);
    m.click('[data-map-up]');
    await m.waitFor('root');
    await sleep(1500);
    const interrupted = camera();
    await m.mount('/f/x');
    await sleep(300);
    return [interrupted, camera()];`);
  expect(interrupted).toBe(mounted);
}, 30_000);

test('on a phone, a level change lands on the same camera as mounting that level', async () => {
  await page.setViewport(390);
  try {
    const [openedFromRoot, build, upFromBuild, root] = await inPage<string[]>(`
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const camera = () => document.querySelector('[data-map-world]').style.transform;
      await m.mount('/f/x');
      m.dblclick('build');
      await m.waitFor('build');
      await sleep(1500);
      const openedFromRoot = camera();
      m.click('[data-map-up]');
      await m.waitFor('root');
      await sleep(1500);
      const upFromBuild = camera();
      await m.mount('/f/x?view=build');
      await sleep(300);
      const build = camera();
      await m.mount('/f/x');
      await sleep(300);
      return [openedFromRoot, build, upFromBuild, camera()];`);
    expect(openedFromRoot).toBe(build);
    expect(upFromBuild).toBe(root);
  } finally {
    await page.setViewport(1440);
  }
}, 30_000);

test('a link to ?view=review opens the Review view, and a double-click on Review opens it from the home map', async () => {
  const [linked, opened] = await inPage<Shown[]>(`
    const linked = await m.mount('/f/x?view=review');
    await m.mount('/f/x');
    m.dblclick('review');
    return [linked, await m.waitFor('review')];`);
  expect(linked).toMatchObject({ view: 'review', search: '?view=review' });
  expect(opened).toMatchObject({ view: 'review', search: '?view=review' });
}, 30_000);

test('Deliver opens from Build, and going up returns to Build and flashes Deliver', async () => {
  const [down, up] = await inPage<Shown[]>(`
    await m.mount('/f/x?view=build');
    m.dblclick('b-del');
    const down = await m.waitFor('build/deliver');
    m.key('Escape');
    await m.waitFor('build');
    return [down, await m.waitFlash('b-del')];`);
  expect(down).toMatchObject({ view: 'build/deliver', search: '?view=build%2Fdeliver' });
  expect(up?.flashed).toContain('b-del');
}, 30_000);

test("Deliver's Review card opens the Review view, and going up returns to Deliver and flashes the card", async () => {
  const [down, up] = await inPage<Shown[]>(`
    await m.mount('/f/x?view=build%2Fdeliver');
    m.dblclick('d-rev');
    const down = await m.waitFor('review');
    m.key('Escape');
    await m.waitFor('build/deliver');
    return [down, await m.waitFlash('d-rev')];`);
  expect(down).toMatchObject({ view: 'review', search: '?view=review&from=build%2Fdeliver' });
  expect(up?.flashed).toContain('d-rev');
}, 30_000);

test('arriving with a card to select shows it selected, in the view the address names', async () => {
  const arrived = await inPage<Shown>(
    `return await m.mount('/f/x?view=app', { select: 'a-check' });`,
  );
  expect(arrived).toMatchObject({ view: 'app', selected: 'a-check' });
}, 30_000);

// The widths the map's column has at 1440 with the Manager dock open and closed, from the shell's tokens.
const tokens = readFileSync(`${import.meta.dir}/../styles.css`, 'utf8');
const token = (name: string) => {
  const width = Number(new RegExp(String.raw`--v3-${name}:\s*(\d+)px`).exec(tokens)?.[1]);
  if (!Number.isFinite(width)) throw new Error(`no --v3-${name} width in styles.css`);
  return width;
};
const CLOSED = 1440 - token('nav-width');
const OPEN = CLOSED - token('manager-width');

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}
interface Geometry {
  stage: Box;
  camera: { x: number; y: number; k: number };
  transition: string;
  cards: Record<string, Box>;
  details: Box | null;
  selected: string | null;
}
type At = [number, number];

const geometry = () => inPage<Geometry>('return m.geometry();');
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const centre = (box: Box): At => [(box.left + box.right) / 2, (box.top + box.bottom) / 2];
const holds = (box: Box, [x, y]: At) =>
  x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;
const inside = (inner: Box, outer: Box) =>
  inner.left >= outer.left - 1 &&
  inner.top >= outer.top - 1 &&
  inner.right <= outer.right + 1 &&
  inner.bottom <= outer.bottom + 1;

const press = (at: At, clickCount = 1) =>
  page.mouse({ type: 'mousePressed', x: at[0], y: at[1], clickCount });
const release = (at: At, clickCount = 1) =>
  page.mouse({ type: 'mouseReleased', x: at[0], y: at[1], clickCount });
async function click(at: At, clickCount = 1) {
  await press(at, clickCount);
  await release(at, clickCount);
}
async function dblclick(at: At) {
  await click(at);
  await click(at, 2);
}
async function drag(from: At, by: At, steps = 8) {
  await press(from);
  for (let i = 1; i <= steps; i++) {
    await page.mouse({
      type: 'mouseMoved',
      x: from[0] + (by[0] * i) / steps,
      y: from[1] + (by[1] * i) / steps,
    });
  }
  await release([from[0] + by[0], from[1] + by[1]]);
}
const wheel = (at: At, deltaY: number) =>
  page.mouse({ type: 'mouseWheel', x: at[0], y: at[1], deltaY });

/** The camera moved by `by` from `before`, at the same scale. */
const movedBy = (after: Geometry, before: Geometry['camera'], by: At) => {
  expect(after.camera.k).toBeCloseTo(before.k, 6);
  expect(after.camera.x).toBeCloseTo(before.x + by[0], 1);
  expect(after.camera.y).toBeCloseTo(before.y + by[1], 1);
};

/** A point of the frame no card holds, clear of the controls and the hint. */
const emptyPoint = (g: Geometry): At => {
  for (let y = g.stage.top + 20; y < g.stage.bottom - 70; y += 20) {
    for (let x = g.stage.left + 20; x < g.stage.right - 20; x += 20) {
      if (!Object.values(g.cards).some((box) => holds(box, [x, y]))) return [x, y];
    }
  }
  throw new Error('no empty point in the frame');
};

const mountAt = async (url: string, width: number) => {
  const mounted = await inPage<Geometry>(
    `await m.mount(${JSON.stringify(url)}, undefined, ${width}); return m.geometry();`,
  );
  // The frame sits in the column with its margins, so a column the test did not get shows as a wider frame.
  expect(mounted.stage.right - mounted.stage.left).toBeLessThan(width);
  return mounted;
};

const sequences = [
  {
    name: 'the root',
    url: '/f/x',
    card: 'build',
    deeper: '/f/x?view=build',
    deeperView: 'build',
    parentView: 'root',
  },
  {
    name: 'Build',
    url: '/f/x?view=build',
    card: 'b-del',
    deeper: '/f/x?view=build%2Fdeliver',
    deeperView: 'build/deliver',
    parentView: 'build',
  },
];

for (const { name, url, card: opening, deeper, deeperView, parentView } of sequences) {
  test(`the map moves however you grab it, on ${name}`, async () => {
    await page.setViewport(1440);
    const parent = (await mountAt(url, OPEN)).camera;
    const child = (await mountAt(deeper, OPEN)).camera;
    const start = await mountAt(url, OPEN);

    // 1. Drag from the background.
    await drag(emptyPoint(start), [50, 30]);
    const dragged = await geometry();
    movedBy(dragged, start.camera, [50, 30]);

    // 2. Click a card: selected, its details inside the frame and clear of the press.
    const pressAt = centre(dragged.cards[opening] as Box);
    await click(pressAt);
    const selected = await geometry();
    expect(selected.selected).toBe(opening);
    expect(selected.details).not.toBeNull();
    expect(inside(selected.details as Box, selected.stage)).toBe(true);
    expect(holds(selected.details as Box, pressAt)).toBe(false);

    // 3. Drag from that card: the map moves and the selection stays.
    await drag(pressAt, [60, 40]);
    const grabbed = await geometry();
    movedBy(grabbed, selected.camera, [60, 40]);
    expect(grabbed.selected).toBe(opening);

    // 4. Open the card's deeper view and drag at once, inside the transition window.
    await dblclick(centre(grabbed.cards[opening] as Box));
    await inPage(`return await m.waitFor(${JSON.stringify(deeperView)});`);
    const corner: At = [grabbed.stage.left + 30, grabbed.stage.top + 30];
    await drag(corner, [-40, 25]);
    const inDeeper = await geometry();
    movedBy(inDeeper, child, [-40, 25]);
    await sleep(800);
    const settled = await geometry();
    expect(settled.camera).toEqual(inDeeper.camera);
    expect(settled.transition).toBe('');

    // 5. Esc goes up; drag at once; then the wheel zooms.
    await inPage(`m.key('Escape'); await m.waitFor(${JSON.stringify(parentView)});`);
    await drag(corner, [35, -20]);
    const back = await geometry();
    movedBy(back, parent, [35, -20]);
    await sleep(800);
    const still = await geometry();
    expect(still.camera).toEqual(back.camera);
    await wheel(centre(still.stage), -300);
    expect((await geometry()).camera.k).toBeGreaterThan(still.camera.k);
  }, 60_000);
}

test('a press released outside the frame before it moved does not leave the map following the mouse', async () => {
  await page.setViewport(1440);
  const start = await mountAt('/f/x', CLOSED);
  const edge: At = [start.stage.right - 3, emptyPoint(start)[1]];
  await press(edge);
  await release([start.stage.right + 40, edge[1]]);
  await page.mouse({ type: 'mouseMoved', x: edge[0] - 60, y: edge[1] + 30 });
  await page.mouse({ type: 'mouseMoved', x: edge[0] - 120, y: edge[1] + 60 });
  expect((await geometry()).camera).toEqual(start.camera);
}, 30_000);

for (const where of ['the background', 'a card']) {
  test(`a finger drag from ${where} keeps moving the map past its first step`, async () => {
    await page.setViewport(1440);
    const start = await mountAt('/f/x', OPEN);
    const from = where === 'a card' ? centre(start.cards.build as Box) : emptyPoint(start);
    await page.touch('touchStart', from[0], from[1]);
    for (let i = 1; i <= 8; i++) {
      await page.touch('touchMove', from[0] + (50 * i) / 8, from[1] + (30 * i) / 8);
    }
    await page.touch('touchEnd', from[0] + 50, from[1] + 30);
    // The slop and the browser's own touch handling eat part of the travel, so compare with one
    // step (6.25 px): a drag that stops after its first step moves the camera no further.
    const moved = (await geometry()).camera;
    expect(moved.x - start.camera.x).toBeGreaterThan(12.5);
    expect(moved.y - start.camera.y).toBeGreaterThan(7.5);
  }, 30_000);
}

for (const [manager, width] of [
  ['open', OPEN],
  ['closed', CLOSED],
] as const) {
  test(`Fit shows every card inside the frame with the Manager ${manager}`, async () => {
    await page.setViewport(1440);
    for (const url of ['/f/x', '/f/x?view=build']) {
      const start = await mountAt(url, width);
      const control = async (label: string) =>
        centre(
          await inPage<Box>(`
            const { left, top, right, bottom } = document
              .querySelector('[aria-label="${label}"]').getBoundingClientRect();
            return { left, top, right, bottom };`),
        );
      await click(await control('Zoom in'));
      await click(await control('Zoom in'));
      await drag(emptyPoint(start), [-70, -40]);
      await click(await control('Fit'));
      const fitted = await geometry();
      for (const [id, box] of Object.entries(fitted.cards)) {
        expect([url, id, inside(box, fitted.stage)]).toEqual([url, id, true]);
      }
    }
  }, 60_000);
}
