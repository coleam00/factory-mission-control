import { expect, test } from 'bun:test';
import { openPage } from '../../scripts/lib/cdp';
import { collectPanelMarks, performanceFailures } from '../../scripts/live/timings';

test.each([false, true])(
  'LivePanel includes expensive row rendering through DOM commit (empty=%s)',
  async (empty) => {
    const bundle = await Bun.build({
      entrypoints: [`${import.meta.dir}/fixtures/render-panel.tsx`],
      target: 'browser',
      format: 'esm',
      define: { 'process.env.NODE_ENV': '"production"' },
    });
    expect(bundle.success).toBe(true);
    const source = Buffer.from(await bundle.outputs[0].text()).toString('base64');
    const page = await openPage(process.env);
    try {
      const rendered = await page.evaluate<{ text: string; visible: boolean; state: string }>(
        `import('data:text/javascript;base64,${source}').then(m => m.renderPanel(${empty}))`,
      );
      expect(rendered).toEqual({
        text: empty ? 'No rows.' : 'delivered row',
        visible: true,
        state: 'ready',
      });
      const timing = (await collectPanelMarks(page, ['home-map'], 0))['home-map'];
      expect(timing.measurementError).toBeNull();
      expect(timing.renderMs).toBeGreaterThanOrEqual(650);
      expect(performanceFailures('home-map', { ...timing, queryExecutionMs: 1 })).toEqual([
        `home-map render ${timing.renderMs} ms, limit 500`,
      ]);
    } finally {
      await page.close();
    }
  },
  30_000,
);
