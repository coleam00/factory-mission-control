import { afterAll, beforeAll, expect, test } from 'bun:test';
import { openPage, type Page } from '../../scripts/lib/cdp';

let page: Page;
let source: string;

beforeAll(async () => {
  const bundle = await Bun.build({
    entrypoints: [`${import.meta.dir}/fixtures/render-flow.tsx`],
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

test('the bar toggle flips the home map and is gone on the other tabs', async () => {
  const seen = await page.evaluate<{ step: string; toggle: boolean; flow: string | null }[]>(
    `import('data:text/javascript;base64,${source}').then(async (m) => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const out = [];
      const note = (step) => out.push({ step, ...m.shown() });
      await m.mount('/f/x');
      await sleep(300);
      note('home');
      m.clickToggle();
      await sleep(100);
      note('toggled');
      m.goBoard();
      await sleep(300);
      note('board');
      return out;
    })`,
  );
  expect(seen).toEqual([
    { step: 'home', toggle: true, flow: 'on' },
    { step: 'toggled', toggle: true, flow: 'off' },
    { step: 'board', toggle: false, flow: null },
  ]);
}, 30_000);
