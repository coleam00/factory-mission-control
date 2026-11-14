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
