import { afterAll, beforeAll, expect, test } from 'bun:test';
import { openPage, type Page } from '../../scripts/lib/cdp';

let page: Page;
let source: string;

beforeAll(async () => {
  const bundle = await Bun.build({
    entrypoints: [`${import.meta.dir}/fixtures/render-manager.tsx`],
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

interface Seen {
  briefing: string | null;
  answer: string | null;
  runLinks: string[];
  undo: boolean;
  toastDetail: string | null;
  chip: string | null;
  surface: string | null;
}

const RUN = '5eed0001-0000-4000-8000-0000000000a1';

test('the panel only talks to the dashboard server: briefing, a question and a proposal with Undo', async () => {
  await page.setViewport(1440);
  const result = await page.evaluate<{
    seen: Seen[];
    requests: { kind: string; url: string; method?: string; body?: string }[];
  }>(
    `import('data:text/javascript;base64,${source}').then(async (m) => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const seen = [];
      m.mount('/f/x');
      await sleep(1200);
      seen.push(m.shown());
      m.clickSuggestion(0);
      await sleep(600);
      seen.push(m.shown());
      m.clickProposal();
      await sleep(300);
      seen.push(m.shown());
      m.clickUndo();
      await sleep(600);
      return { seen, requests: m.requests() };
    })`,
  );
  const [briefed, answered, proposed] = result.seen;
  expect(briefed.briefing).toContain('Quiet night.');
  expect(briefed.chip).toBe('Attention');
  expect(answered.answer).toBe('done');
  expect(answered.runLinks).toContain(RUN);
  expect(proposed.undo).toBe(true);

  const bodies = result.requests.map((r) => `${r.method ?? ''} ${r.url} ${r.body ?? ''}`);
  expect(bodies.some((b) => b.includes('/api/manager/briefing'))).toBe(true);
  // The server refuses any key the action endpoint does not name, so the proposal's own `type` and `label` must not ride along.
  const sent = result.requests.find((r) => r.url === '/api/actions' && r.method === 'POST');
  expect(JSON.parse(sent?.body ?? '{}')).toEqual({
    factory: 'x',
    action: 'resume',
    run_id: RUN,
    from_step: null,
    undone: true,
  });
  const chat = result.requests.find((r) => r.url === '/api/manager/chat');
  expect(JSON.parse(chat?.body ?? '{}').context.place).toBe('attention');
  expect(
    result.requests.some(
      (r) => r.url === '/api/actions' && r.method === 'POST' && r.body?.includes('"undone":true'),
    ),
  ).toBe(true);

  // Nothing leaves for a model provider or any other host: every request is a same-origin /api/ path.
  for (const request of result.requests) {
    expect(request.kind, request.url).toBe('fetch');
    expect(request.url.startsWith('/api/'), request.url).toBe(true);
  }
}, 30_000);

test('answering with a proposed option names the option wording in the Undo toast', async () => {
  await page.setViewport(1440);
  const result = await page.evaluate<{
    seen: Seen;
    requests: { url: string; method?: string; body?: string }[];
  }>(
    `import('data:text/javascript;base64,${source}').then(async (m) => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      // The action flow is module state shared by every test here: wait out the previous test's toast.
      await sleep(5500);
      m.mount('/f/x');
      await sleep(1200);
      m.clickSuggestion(0);
      await sleep(600);
      m.clickProposal('answer');
      await sleep(300);
      const seen = m.shown();
      m.clickUndo();
      await sleep(600);
      return { seen, requests: m.requests() };
    })`,
  );
  expect(result.seen.toastDetail).toBe('Ship it');
  // The endpoint refuses unknown keys: the proposal's `type`, `label` and `detail` must not ride along.
  const sent = result.requests.find((r) => r.url === '/api/actions' && r.method === 'POST');
  expect(JSON.parse(sent?.body ?? '{}')).toEqual({
    factory: 'x',
    action: 'answer',
    run_id: RUN,
    occurrence: 'ask-1',
    option: 'yes',
    text: null,
    undone: true,
  });
}, 30_000);

test('an address ending in #manager opens the phone tab, looking at the run on screen', async () => {
  await page.setViewport(390);
  const seen = await page.evaluate<Seen>(
    `import('data:text/javascript;base64,${source}').then(async (m) => {
      location.hash = '#manager';
      m.mount('/f/x/runs/${RUN}');
      await new Promise((r) => setTimeout(r, 1200));
      return m.shown();
    })`,
  );
  expect(seen.surface).toBe('tab');
  expect(seen.chip).toBe('Run 5eed0001');
}, 30_000);

test('switching factory with the panel open gives the new factory its own briefing', async () => {
  await page.setViewport(1440);
  const result = await page.evaluate<{ briefing: string | null; briefed: string[] }>(
    `import('data:text/javascript;base64,${source}').then(async (m) => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      m.mount('/f/x');
      await sleep(1200);
      m.go('/f/y');
      await sleep(1200);
      return {
        briefing: m.shown().briefing,
        briefed: m.requests().filter((r) => r.url === '/api/manager/briefing').map((r) => r.body),
      };
    })`,
  );
  expect(result.briefing).toContain('Quiet night.');
  expect(result.briefed).toEqual(['{"factory":"x"}', '{"factory":"y"}']);
}, 30_000);
