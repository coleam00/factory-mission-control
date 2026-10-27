import { afterAll, beforeAll, expect, test } from 'bun:test';
import { onTheSeed } from '../../db/queries/test-seed';
import { MARKER } from '../fixture/seed-report';
import type { Page } from '../lib/cdp';
import type { Db } from '../lib/db';
import { checkAppRise, seedTestingMismatches } from './testing';

let db: Db;

beforeAll(async () => {
  db = await onTheSeed();
}, 60_000);

afterAll(() => db.close());

const c = (count: number) => ({ count, listed: count });

/** What the testing screen shows on the seed, read as test:live reads it. */
const seedScreen = {
  routes: [
    { route: 'simple', depth: 'normal', ...c(18) },
    { route: 'continue', depth: 'normal', ...c(7) },
    { route: 'none', depth: 'light', ...c(3) },
    { route: 'complex', depth: 'normal', ...c(2) },
    { route: '', depth: '', ...c(1) },
  ],
  checks: [
    { kind: 'criterion', verdict: 'PASS', ...c(18) },
    { kind: 'holdout', verdict: 'FAIL', ...c(5) },
    { kind: 'holdout', verdict: 'PASS', ...c(18) },
    { kind: 'probe', verdict: 'OK', ...c(18) },
    { kind: 'defect', verdict: 'DEFECT', ...c(1) },
  ],
  prHoldouts: [
    { scenario: 'H-01', verdict: 'PASS', ...c(18) },
    ...['H-02', 'H-03', 'H-04', 'H-06', 'unidentified'].map((scenario) => ({
      scenario,
      verdict: 'FAIL',
      ...c(1),
    })),
  ],
  defaultHoldouts: [
    { scenario: 'H-01', verdict: 'PASS', issue: null },
    { scenario: 'H-02', verdict: 'FAIL', issue: 14 },
    { scenario: 'H-04', verdict: 'PASS', issue: null },
  ],
  failing: [{ scenario: 'H-02', issue: 14 }],
  scenarios: ['H-01', 'H-02', 'unidentified'],
  markers: 0,
};

const pageShowing = (shown: unknown): Page => ({
  evaluate: async <T>() => shown as T,
  goto: async () => {},
  setViewport: async () => {},
  screenshot: async () => Buffer.alloc(0),
  close: async () => {},
});

test('the seed screen matches SQL over the seed', async () => {
  const { mismatches, report } = await seedTestingMismatches(
    pageShowing(seedScreen),
    db,
    'mission-control',
  );
  expect(mismatches).toEqual([]);
  expect(report).toEndWith('mismatches: 0');
});

test('a wrong count, a short lap list, holdout text and a failing row with no issue each fail', async () => {
  const [simple, ...routes] = seedScreen.routes;
  const { mismatches } = await seedTestingMismatches(
    pageShowing({
      ...seedScreen,
      routes: [{ ...simple, listed: 17 }, ...routes],
      checks: seedScreen.checks.map((r) => (r.kind === 'probe' ? { ...r, ...c(17) } : r)),
      scenarios: [...seedScreen.scenarios, 'scenario text'],
      failing: [{ scenario: 'H-02', issue: null }],
      markers: 1,
    }),
    db,
    'mission-control',
  );
  expect(mismatches).toEqual([
    expect.stringMatching(/^the checks: screen/),
    expect.stringMatching(/^the failing: screen/),
    expect.stringContaining('data-count 18, lists 17'),
    'a data-scenario reads "scenario text", not H-<nn> or unidentified',
    `${MARKER} occurs 1 times on the page`,
    'no scenario failing on the default branch shows its tracking issue',
  ]);
});

test("fixture:write's check-app report adds one criterion PASS, holdout PASS and probe OK", () => {
  expect(Object.fromEntries(checkAppRise())).toEqual({
    '["criterion","PASS"]': 1,
    '["holdout","PASS"]': 1,
    '["probe","OK"]': 1,
  });
});
