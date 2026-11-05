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
  75_000,
);

test('a panel whose connection ended for good shows its rows again once sealing is back, never asking back to back (#274)', async () => {
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
    // Never back to back: each seal after the first waits at least the backoff's first wait for the
    // last. Whether any is asked before the new client goes live on the seal it still has depends
    // on which comes first: `LivePanel.test.ts` tests the doubling.
    const gaps = recovered.asked.slice(1).map((at, i) => at - recovered.asked[i]);
    expect(gaps.every((gap) => gap >= 1_000)).toBe(true);
  } finally {
    await page.close();
  }
}, 85_000);

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
  85_000,
);

test('a subscription that is live for a moment and then fails again and again does not reset the seal backoff (#274)', async () => {
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
    const { asked } = await page.evaluate<{ asked: number[] }>(
      `import('data:text/javascript;base64,${source}').then(m => m.renderFlapping(12000))`,
    );
    // Every seal is answered 200 and each subscription is live before it fails, so a wait reset by
    // going live asks about once a second: 10 seals in 12 s. The doubling wait asks 3 or 4 times.
    expect(asked.length).toBeLessThanOrEqual(5);
    expect(asked.length).toBeGreaterThanOrEqual(3);
  } finally {
    await page.close();
  }
}, 85_000);

async function inPage<T>(call: string): Promise<T> {
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
    return await page.evaluate<T>(
      `import('data:text/javascript;base64,${source}').then(m => m.${call})`,
      35_000,
    );
  } finally {
    await page.close();
  }
}

test('a client whose connection ends for good again and again is replaced after a doubling wait, not about once a second (#274)', async () => {
  const { opened } = await inPage<{ opened: number[] }>('renderOutage(20000)');
  // Each replacement client ends for good 300 ms after its row. A constant 1 s wait opens about 14
  // clients in 20 s; the doubling one (1, 2, 4, 8 s) opens 4, each gap longer than the last.
  expect(opened.length).toBeGreaterThanOrEqual(3);
  expect(opened.length).toBeLessThanOrEqual(6);
  expect(opened[2] - opened[1]).toBeGreaterThan(opened[1] - opened[0]);
}, 85_000);

test('a panel that stays live for the stable time owes no extra wait when it fails again (#274)', async () => {
  const { asked } = await inPage<{ asked: number[] }>('renderFlapping(28000, [300, 300, 18000])');
  // The first two subscriptions fail at once, so the wait has grown to 4 s. The third is live 18 s,
  // longer than the 16 s the wait holds, and its failure starts the wait over at 1 s: its re-seal
  // is asked about 19 s after the last. Unreset, the wait would be 16 s and no seal comes in time.
  expect(asked.length).toBeGreaterThanOrEqual(4);
  expect(asked[3] - asked[2]).toBeLessThan(21_000);
}, 85_000);
