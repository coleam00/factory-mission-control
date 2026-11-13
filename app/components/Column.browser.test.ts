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
    entrypoints: [`${import.meta.dir}/fixtures/render-layout.tsx`],
    target: 'browser',
    format: 'esm',
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  expect(bundle.success).toBe(true);
  source = Buffer.from(await bundle.outputs[0].text()).toString('base64');
  page = await openPage(process.env);
  await page.setViewport(1440);
  await page.goto('about:blank');
  const css = JSON.stringify(await stylesheet());
  await page.evaluate(
    `document.head.append(Object.assign(document.createElement('style'), { textContent: ${css} }))`,
  );
}, 90_000);

afterAll(async () => {
  await page?.close();
});

interface Gaps {
  left: number;
  right: number;
  sideways: boolean;
}

const measure = (url: string, managerOpen: boolean) =>
  page.evaluate<Gaps | null>(
    `import('data:text/javascript;base64,${source}').then(async (m) => {
      m.mount(${JSON.stringify(url)});
      await new Promise((r) => setTimeout(r, 1000));
      m.setManager(${managerOpen});
      await new Promise((r) => setTimeout(r, 300));
      return m.gaps();
    })`,
  );

for (const place of ['', '/board', '/runs']) {
  const url = `/f/x${place}`;

  test(`${url} centers its column at 1440 px with the Manager closed`, async () => {
    const gaps = await measure(url, false);
    expect(gaps).not.toBeNull();
    expect(Math.abs((gaps?.left ?? 0) - (gaps?.right ?? 99999))).toBeLessThanOrEqual(24);
    expect(gaps?.left).toBeGreaterThan(0);
  }, 30_000);

  test(`${url} fits beside the open Manager without sideways scrolling`, async () => {
    const gaps = await measure(url, true);
    expect(gaps?.sideways).toBe(false);
    expect(gaps?.left).toBeGreaterThanOrEqual(0);
    expect(gaps?.right).toBeGreaterThanOrEqual(0);
  }, 30_000);
}

const shellAt = (managerOpen: boolean) =>
  page.evaluate<{
    phone: boolean | null;
    attention: { width: number; left: number; right: number } | null;
    manager: { width: number; left: number } | null;
  }>(
    `import('data:text/javascript;base64,${source}').then(async (m) => {
      m.mount('/f/x');
      await new Promise((r) => setTimeout(r, 1000));
      m.setManager(${managerOpen});
      await new Promise((r) => setTimeout(r, 300));
      return m.shell();
    })`,
  );

test('820 px uses the phone layout, and Attention keeps a readable column with the Manager closed', async () => {
  await page.setViewport(820, 1000);
  const { phone, attention } = await shellAt(false);
  expect(phone).toBe(true);
  expect(attention?.width).toBeGreaterThanOrEqual(360);
}, 30_000);

test('820 px shows the Manager as a full-screen tab with no page content under it', async () => {
  await page.setViewport(820, 1000);
  const { phone, attention, manager } = await shellAt(true);
  expect(phone).toBe(true);
  expect(attention).toBeNull();
  expect(manager).toEqual({ width: 820, left: 0 });
}, 30_000);

test('1024 px still draws the desktop shell, with the Manager docked beside the page', async () => {
  await page.setViewport(1024, 1000);
  const { phone, manager } = await shellAt(true);
  expect(phone).toBe(false);
  expect(manager?.width).toBe(384);
  await page.setViewport(1440);
}, 30_000);
