import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { openPage } from '../../scripts/lib/cdp';

/** The lap page's real components, with each live panel handing over fixed rows at once. */
async function bundle(): Promise<string> {
  const built = await Bun.build({
    entrypoints: [`${import.meta.dir}/fixtures/render-one-lap.tsx`],
    target: 'browser',
    format: 'esm',
    define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [
      {
        name: 'delivered-panel',
        setup(build) {
          build.onResolve({ filter: /\/live\/LivePanel$/ }, () => ({
            path: join(import.meta.dir, 'fixtures', 'delivered-panel.tsx'),
          }));
        },
      },
    ],
  });
  expect(built.success).toBe(true);
  return Buffer.from(await built.outputs[0].text()).toString('base64');
}

test('a disposition on the lap page names the position of the APP CHECK line with its id', async () => {
  const source = await bundle();
  const page = await openPage(process.env);
  try {
    const render = (checks: string) =>
      page.evaluate<{
        dispositions: Record<string, string | null>[];
        lines: Record<string, string | null>[];
      }>(`import('data:text/javascript;base64,${source}').then(m => m.renderOneLap('${checks}'))`);

    const ready = await render('ready');
    const h2 = ready.lines.find((l) => l['data-line-id'] === 'H2');
    expect(h2?.['data-position']).toBe('4');
    expect(ready.dispositions).toEqual([
      { 'data-line': 'H2', 'data-check-position': '4', 'data-unmatched': null },
      { 'data-line': 'H9', 'data-check-position': null, 'data-unmatched': '' },
    ]);

    // Rows an app check kept from before an outage are not this lap's lines now.
    const outage = await render('error');
    expect(outage.dispositions).toEqual([
      { 'data-line': 'H2', 'data-check-position': null, 'data-unmatched': null },
      { 'data-line': 'H9', 'data-check-position': null, 'data-unmatched': null },
    ]);
  } finally {
    await page.close();
  }
}, 30_000);
