import { afterAll, beforeAll, expect, test } from 'bun:test';
import { openPage, type Page } from '../../scripts/lib/cdp';
import type { Asked } from './fixtures/render-step';

const OLDER = '8e3e1cefaf1e1b7955789d6a43a81b6c2dbd7082';
const NEWER = '5ffd60c6c6e591487f2fbb5ec67ccc8fc55ca915';
const BEFORE_REVIEW = '1b2a52a5d44d3a1b1d8f2d4d3c6c2e0f9a8b7c6d';

const STEP_QUERIES = [
  'step-detail',
  'step-nesting',
  'step-prompt',
  'step-subagents',
  'step-scripts',
  'step-hooks',
  'step-yaml',
];

interface Shown {
  state: string | null;
  prompt: string | null;
  sentence: string | null;
}

let page: Page;
let source: string;

beforeAll(async () => {
  const bundle = await Bun.build({
    entrypoints: [`${import.meta.dir}/fixtures/render-step.tsx`],
    target: 'browser',
    format: 'esm',
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  expect(bundle.success).toBe(true);
  source = Buffer.from(await bundle.outputs[0].text()).toString('base64');
  page = await openPage(process.env);
}, 30_000);

afterAll(async () => {
  await page?.close();
});

const inPage = <T>(call: string) =>
  page.evaluate<T>(`import('data:text/javascript;base64,${source}').then(m => m.${call})`);

const openStep = (url: string) =>
  inPage<{ shown: Shown; asked: Asked[] }>(`openStep(${JSON.stringify(url)})`);

/** The version each query was sealed for: its last parameter, or none for the picker's. */
const versions = (asked: Asked[]) =>
  Object.fromEntries(asked.map(({ query, args }) => [query, args.at(-1) ?? null]));

test('every step query is sealed for the version the address names, and shows its files', async () => {
  const { shown, asked } = await openStep(`/steps/archon-loop/review?at=${OLDER}`);
  expect(shown).toEqual({ state: 'ready', prompt: `Review at ${OLDER}`, sentence: null });
  expect(versions(asked)).toEqual({
    'step-versions': null,
    ...Object.fromEntries(STEP_QUERIES.map((query) => [query, OLDER])),
  });
}, 30_000);

test('without a version every step query is sealed for the current one', async () => {
  const { shown, asked } = await openStep('/steps/archon-loop/review');
  expect(shown).toEqual({ state: 'ready', prompt: 'Review, current', sentence: null });
  expect(versions(asked)).toEqual({
    'step-versions': null,
    ...Object.fromEntries(STEP_QUERIES.map((query) => [query, ''])),
  });
}, 30_000);

test('a version nobody recorded, and one without the step, each read one sentence', async () => {
  expect((await openStep('/steps/archon-loop/review?at=not-a-version')).shown).toEqual({
    state: 'ready',
    prompt: null,
    sentence: 'No version not-a-version is recorded for this factory.',
  });
  expect((await openStep(`/steps/archon-loop/review?at=${BEFORE_REVIEW}`)).shown).toEqual({
    state: 'ready',
    prompt: null,
    sentence: 'No step review in archon-loop at version 1b2a52a5.',
  });
}, 30_000);

test("choosing another version never shows the last one's files while the new one is asked for", async () => {
  const { pending, after } = await inPage<{ pending: Shown[]; after: Shown }>('switchVersion()');
  expect(pending).toEqual([{ state: 'loading', prompt: null, sentence: '' }]);
  expect(after).toEqual({ state: 'ready', prompt: `Review at ${NEWER}`, sentence: null });
}, 30_000);

// No step query waits for another's result: each takes only the factory, the address's workflow
// and path, and its version, so every one is asked for at navigation.
test('every step panel asks for its seal at navigation, not after step-detail answers', async () => {
  const { whileHeld, after } = await inPage<{
    whileHeld: { asked: string[]; detail: string | null; requested: string[] };
    after: Shown;
  }>('openHeld()');
  const all = ['step-versions', ...STEP_QUERIES].sort();
  expect(whileHeld).toEqual({ asked: all, detail: 'loading', requested: all });
  expect(after).toEqual({ state: 'ready', prompt: 'Review, current', sentence: null });
}, 30_000);
