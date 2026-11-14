import { afterAll, beforeAll, expect, test } from 'bun:test';
import { compile } from '@tailwindcss/node';
import { Scanner } from '@tailwindcss/oxide';
import { openPage, type Page } from '../../scripts/lib/cdp';

let page: Page;
let source: string;

/** The app's stylesheet as Tailwind builds it for every class the app's sources use. */
async function stylesheet(): Promise<string> {
  const base = `${import.meta.dir}/..`;
  const compiler = await compile(await Bun.file(`${base}/styles.css`).text(), {
    base,
    onDependency() {},
  });
  const scanner = new Scanner({ sources: [{ base, pattern: '**/*', negated: false }] });
  return compiler.build(scanner.scan());
}

beforeAll(async () => {
  const bundle = await Bun.build({
    entrypoints: [`${import.meta.dir}/fixtures/render-board.tsx`],
    target: 'browser',
    format: 'esm',
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  expect(bundle.success).toBe(true);
  source = Buffer.from(await bundle.outputs[0].text()).toString('base64');
  page = await openPage(process.env);
  await page.setViewport(1440, 900);
  await page.goto('about:blank');
  const css = JSON.stringify(await stylesheet());
  await page.evaluate(
    `document.head.append(Object.assign(document.createElement('style'), { textContent: ${css} }))`,
  );
}, 90_000);

afterAll(async () => {
  await page?.close();
});

interface Placement {
  innerHeight: number;
  paneScrollTop: number;
  top: number;
  bottom: number;
  listScrolls: boolean;
  sideways: boolean;
  foundTop: number;
}

/** Mounts the Board with `orders` work orders, sets the Manager, and measures the Build column. */
const measure = (orders: number, managerOpen: boolean) =>
  page.evaluate<Placement | null>(
    `import('data:text/javascript;base64,${source}').then(async (m) => {
      m.mount(${orders});
      await new Promise((r) => setTimeout(r, 1000));
      m.setManager(${managerOpen});
      await new Promise((r) => setTimeout(r, 300));
      return m.measure();
    })`,
  );

const settle = () => new Promise((r) => setTimeout(r, 400));

for (const orders of [0, 3]) {
  for (const managerOpen of [false, true]) {
    test(`a tall Pipeline column ends inside the window at 1440x900 with ${orders} work orders, Manager ${managerOpen ? 'open' : 'closed'}`, async () => {
      const column = await measure(orders, managerOpen);
      expect(column).not.toBeNull();
      expect(column?.paneScrollTop).toBe(0);
      expect(column?.bottom).toBeLessThanOrEqual(column?.innerHeight ?? 0);
      expect(column?.listScrolls).toBe(true);
      expect(column?.sideways).toBe(false);
      expect(column?.foundTop).toBeGreaterThanOrEqual(column?.bottom ?? 0);
    }, 30_000);
  }
}

test('a column crowded down by work orders keeps a usable height that fits the window', async () => {
  const column = await measure(20, true);
  expect(column).not.toBeNull();
  const height = (column?.bottom ?? 0) - (column?.top ?? 0);
  expect(height).toBeGreaterThanOrEqual(320);
  expect(height).toBeLessThanOrEqual(column?.innerHeight ?? 0);
}, 30_000);

test('a column stays inside the window after the window narrows and moves the row down', async () => {
  try {
    await page.setViewport(2400, 900);
    await measure(3, true);
    await page.setViewport(1440, 900);
    await settle();
    const column = await page.evaluate<Placement | null>(
      `import('data:text/javascript;base64,${source}').then((m) => m.measure())`,
    );
    expect(column).not.toBeNull();
    expect(column?.bottom).toBeLessThanOrEqual(column?.innerHeight ?? 0);
  } finally {
    await page.setViewport(1440, 900);
  }
}, 30_000);

test('below 760px a tall column is not capped and its list does not scroll inside itself', async () => {
  try {
    await page.setViewport(390, 844);
    const column = await measure(0, false);
    expect(column).not.toBeNull();
    expect(column?.listScrolls).toBe(false);
    expect((column?.bottom ?? 0) - (column?.top ?? 0)).toBeGreaterThan(column?.innerHeight ?? 0);
  } finally {
    await page.setViewport(1440, 900);
  }
}, 30_000);

type Fades = {
  left: string | null;
  right: string | null;
  mergedVisible: boolean;
  scrollLeft: number;
};

const fades = (mount: string) =>
  page.evaluate<Fades>(
    `import('data:text/javascript;base64,${source}').then(async (m) => {
      m.mount(0);
      await new Promise((r) => setTimeout(r, 1000));
      ${mount}
      return m.fades();
    })`,
  );

test('with the Manager closed at 1440 all seven columns fit and no hint shows', async () => {
  const f = await fades('m.setManager(false); await new Promise((r) => setTimeout(r, 300));');
  expect(f).toEqual({ left: null, right: null, mergedVisible: true, scrollLeft: 0 });
}, 30_000);

test('with the Manager open each hidden edge names its columns and a click brings them into view', async () => {
  const f = await fades('m.setManager(true); await new Promise((r) => setTimeout(r, 300));');
  expect(f.left).toBeNull();
  expect(f.right).toMatch(/Merged 0 →$/);
  expect(f.mergedVisible).toBe(false);
  const after = await page.evaluate<Fades>(
    `import('data:text/javascript;base64,${source}').then(async (m) => { await m.clickFade('right'); return m.fades(); })`,
  );
  expect(after.mergedVisible).toBe(true);
  expect(after.right).toBeNull();
  expect(after.left).toMatch(/^← Intake 0/);
  const back = await page.evaluate<Fades>(
    `import('data:text/javascript;base64,${source}').then(async (m) => { await m.clickFade('left'); return m.fades(); })`,
  );
  expect(back.left).toBeNull();
  expect(back.scrollLeft).toBe(0);
  expect(back.right).toMatch(/Merged 0 →$/);
}, 30_000);

const focusAt = () =>
  page.evaluate<{ inBoard: boolean; isBody: boolean; scrollLeft: number }>(
    `import('data:text/javascript;base64,${source}').then((m) => m.focusAt())`,
  );

const withManagerOpen = () =>
  fades('m.setManager(true); await new Promise((r) => setTimeout(r, 300));');

const focusFade = (side: 'left' | 'right') =>
  page.evaluate(
    `import('data:text/javascript;base64,${source}').then((m) => m.focusFade('${side}'))`,
  );

test('Enter on the right hint keeps focus in the Board, and Tab keeps Merged in view', async () => {
  await withManagerOpen();
  await focusFade('right');
  await page.key('Enter');
  await Bun.sleep(1200);
  const entered = await focusAt();
  expect(entered.isBody).toBe(false);
  expect(entered.inBoard).toBe(true);
  expect(entered.scrollLeft).toBeGreaterThan(0);
  await page.key('Tab');
  await Bun.sleep(600);
  expect((await focusAt()).scrollLeft).toBeGreaterThan(0);
  const after = await page.evaluate<Fades>(
    `import('data:text/javascript;base64,${source}').then((m) => m.fades())`,
  );
  expect(after.mergedVisible).toBe(true);
}, 30_000);

test('Enter on the left hint keeps focus in the Board', async () => {
  await withManagerOpen();
  await page.evaluate(
    `import('data:text/javascript;base64,${source}').then((m) => m.clickFade('right'))`,
  );
  await focusFade('left');
  await page.key('Enter');
  await Bun.sleep(1200);
  const entered = await focusAt();
  expect(entered.isBody).toBe(false);
  expect(entered.inBoard).toBe(true);
  expect(entered.scrollLeft).toBe(0);
}, 30_000);
