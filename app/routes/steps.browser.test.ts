import { afterAll, beforeAll, expect, test } from 'bun:test';
import { openPage, type Page } from '../../scripts/lib/cdp';
import { ALL_STEP_QUERIES, STEP_QUERIES, STEP_VERSIONS_QUERY } from '../lib/step-queries';
import type { Asked } from './fixtures/render-step';

const OLDER = '8e3e1cefaf1e1b7955789d6a43a81b6c2dbd7082';
const NEWER = '5ffd60c6c6e591487f2fbb5ec67ccc8fc55ca915';
const BEFORE_REVIEW = '1b2a52a5d44d3a1b1d8f2d4d3c6c2e0f9a8b7c6d';

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
}, 90_000);

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
  const { shown, asked } = await openStep(`/f/factory-a/steps/archon-loop/review?at=${OLDER}`);
  expect(shown).toEqual({ state: 'ready', prompt: `Review at ${OLDER}`, sentence: null });
  expect(versions(asked)).toEqual({
    [STEP_VERSIONS_QUERY]: null,
    ...Object.fromEntries(STEP_QUERIES.map((query) => [query, OLDER])),
  });
}, 30_000);

test('without a version every step query is sealed for the current one', async () => {
  const { shown, asked } = await openStep('/f/factory-a/steps/archon-loop/review');
  expect(shown).toEqual({ state: 'ready', prompt: 'Review, current', sentence: null });
  expect(versions(asked)).toEqual({
    [STEP_VERSIONS_QUERY]: null,
    ...Object.fromEntries(STEP_QUERIES.map((query) => [query, ''])),
  });
}, 30_000);

test('a version nobody recorded, and one without the step, each read one sentence', async () => {
  expect((await openStep('/f/factory-a/steps/archon-loop/review?at=not-a-version')).shown).toEqual({
    state: 'ready',
    prompt: null,
    sentence: 'No version not-a-version is recorded for this factory.',
  });
  expect(
    (await openStep(`/f/factory-a/steps/archon-loop/review?at=${BEFORE_REVIEW}`)).shown,
  ).toEqual({
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
  const all = [...ALL_STEP_QUERIES].sort();
  expect(whileHeld).toEqual({ asked: all, detail: 'loading', requested: all });
  expect(after).toEqual({ state: 'ready', prompt: 'Review, current', sentence: null });
}, 30_000);

test('every panel beside step-detail is sealed for the workflow and path the address names', async () => {
  const { asked } = await openStep(`/f/factory-a/steps/archon-loop/review?at=${OLDER}`);
  const beside = asked.filter(({ query }) =>
    (STEP_QUERIES.slice(1) as readonly string[]).includes(query),
  );
  expect(beside.map(({ query, args }) => [query, args])).toEqual(
    STEP_QUERIES.slice(1).map((query) => [query, ['archon-loop', 'review', OLDER]]),
  );
}, 30_000);

test('the old step address ends on the factory-scoped one, keeping the version', async () => {
  const placed = await openPlace(`/steps/archon-loop/review?at=${OLDER}`);
  expect(placed.location).toBe(`/f/factory-a/steps/archon-loop/review?at=${OLDER}`);
  expect(placed.prompt).toEqual([`Review at ${OLDER}`]);
}, 30_000);

test("a step's Trigger rule shows its rule, and a dash when it declares none", async () => {
  const rule = (step: string) =>
    inPage<string | null>(
      `triggerRuleAt(${JSON.stringify(`/f/factory-a/steps/archon-loop/${step}`)})`,
    );
  expect(await rule('finalize')).toBe('all_done');
  expect(await rule('review')).toBe('-');
}, 30_000);

interface Crumbs {
  opened: { href: string | null; text: string | null };
  moved: { href: string | null; text: string | null };
  expectedDefault: { href: string; label: string };
}

test('the breadcrumb returns to where the step was opened from, and keeps it while the screen stays open', async () => {
  const from = { href: '/f/factory-a', label: 'Factory / App check', card: 'app' };
  const crumbs = await inPage<Crumbs>(`breadcrumbOf(${JSON.stringify({ from })})`);
  expect(crumbs.opened).toEqual({ href: from.href, text: from.label });
  expect(crumbs.moved).toEqual(crumbs.opened);
}, 30_000);

test('without an opener the breadcrumb returns to the map card that covers the step', async () => {
  const crumbs = await inPage<Crumbs>('breadcrumbOf(undefined)');
  const { href, label } = crumbs.expectedDefault;
  expect(crumbs.opened).toEqual({ href, text: label });
}, 30_000);

// The first test to lose a subscription makes later seals for the same step wait, so the ones
// that open `review` at the current version come before it.
test('once step-detail no longer shows the step, no panel beside it shows that step', async () => {
  expect(
    await inPage<{ detail: string; sentence: string; headings: string[] }>('loseStep()'),
  ).toEqual({ detail: 'error', sentence: 'Live data is unavailable.', headings: [] });
}, 30_000);

const TWICE = 'ac1ace0000000000000000000000000000000000';

interface Placed {
  location: string;
  title: string;
  routes: { path: string; inputs: string | null }[];
  includedAt: { place: string; current: boolean }[];
  prompt: string[];
}

const openPlace = (url: string) => inPage<Placed>(`openPlace(${JSON.stringify(url)})`);

test("an included block's shared address opens its first place, keeping the version", async () => {
  const placed = await openPlace(`/f/factory-a/steps/block/code?at=${TWICE}`);
  expect(placed.location).toBe(`/f/factory-a/steps/archon-loop/review%2Fcode?at=${TWICE}`);
  expect(placed.prompt).toEqual(['Write the code']);
}, 30_000);

test('a place shows the definition, its own path, the routing around it and every place', async () => {
  const placed = await openPlace(`/f/factory-a/steps/archon-loop/rereview%2Fcode?at=${TWICE}`);
  expect(placed.location).toBe(`/f/factory-a/steps/archon-loop/rereview%2Fcode?at=${TWICE}`);
  expect(placed.title).toBe('rereview/code');
  expect(placed.prompt).toEqual(['Write the code']);
  expect(placed.routes).toEqual([{ path: 'rereview', inputs: 'fix' }]);
  expect(placed.includedAt).toEqual([
    { place: 'archon-loop review/code', current: false },
    { place: 'archon-loop rereview/code', current: true },
  ]);
}, 30_000);
