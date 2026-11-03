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

test('a panel whose connection ended for good shows its rows again once sealing is back, asking at the backoff (#274)', async () => {
  const bundle = await Bun.build({
    entrypoints: [`${import.meta.dir}/fixtures/render-recovery.tsx`],
    target: 'browser',
    format: 'esm',
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  expect(bundle.success).toBe(true);
  const source = Buffer.from(await bundle.outputs[0].text()).toString('base64');
  const page = await openPage(process.env);
  try {
    const failures = 2;
    const recovered = await page.evaluate<{
      state: string;
      text: string;
      asked: number[];
      states: string[];
    }>(
      `import('data:text/javascript;base64,${source}').then(m => m.renderRecovery(${failures}, 15000))`,
    );
    // Live, then unavailable when the connection ended, then live again without a reload.
    expect(recovered.states[0]).toBe('loading loading');
    expect(recovered.states).toContain('ready the lap');
    expect(recovered.states).toContain('error error');
    expect(recovered.state).toBe('ready');
    expect(recovered.text).toBe('the lap');
    // The first seal; then, once the connection ended (300 ms after the rows), one a wait of 1 s
    // later, the failed ones, and the one the panel is live on: never back to back, each at least
    // the backoff's first wait after the last, and none once the panel is live. (Whether the wait
    // then doubles depends on which comes first, the new client going live on the seal it still
    // has, which resets the wait, or the next failed seal: `LivePanel.test.ts` tests the doubling.)
    expect(recovered.asked).toHaveLength(2 + failures);
    expect(recovered.asked[1]).toBeGreaterThanOrEqual(1_300);
    const gaps = recovered.asked.slice(2).map((at, i) => at - recovered.asked[i + 1]);
    expect(gaps.every((gap) => gap >= 1_000)).toBe(true);
  } finally {
    await page.close();
  }
}, 40_000);

test.each([
  ['both', 'both of its clients'],
  ['home', 'only its home client'],
] as const)(
  'a rewound page whose connection ended for good on %s recovers every panel (#274)',
  async (rewound) => {
    const bundle = await Bun.build({
      entrypoints: [`${import.meta.dir}/fixtures/render-recovery.tsx`],
      target: 'browser',
      format: 'esm',
      define: { 'process.env.NODE_ENV': '"production"' },
    });
    expect(bundle.success).toBe(true);
    const source = Buffer.from(await bundle.outputs[0].text()).toString('base64');
    const page = await openPage(process.env);
    try {
      const result = await page.evaluate<{
        state: string;
        text: string;
        homeState: string;
        homeText: string;
      }>(
        `import('data:text/javascript;base64,${source}').then(m => m.renderRecovery(1, 20000, '${rewound}'))`,
      );
      expect([result.state, result.text]).toEqual(['ready', 'the lap']);
      expect([result.homeState, result.homeText]).toEqual(['ready', 'the lap']);
    } finally {
      await page.close();
    }
  },
  40_000,
);
