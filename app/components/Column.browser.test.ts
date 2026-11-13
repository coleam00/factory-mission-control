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
