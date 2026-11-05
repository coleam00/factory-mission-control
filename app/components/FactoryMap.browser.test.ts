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
}, 75_000);

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
