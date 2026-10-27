import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '../lib/cdp';
import type { Db } from '../lib/db';
import { scratchRepo } from '../lib/test-deps';
import {
  compareDecision,
  compareDecisionDestination,
  decisionDestinationPhase,
  decisionDestinations,
  decisionHref,
} from './decisions';

const decisionSeed = {
  date: '2026-10-09',
  title: 'Drop briefs',
  version: '5ffd60c6',
  pin_sha: '5ffd60c6full',
  digest: 'sha256:b2b2',
};

test('decision assertions require the factory, full pin and encoded digest from the seed join', () => {
  const href = '/f/second%20factory/versions?pin=5ffd60c6full&digest=sha256%3Ab2b2';
  expect(decisionHref(decisionSeed, 'second factory')).toBe(href);
  const shown = {
    date: decisionSeed.date,
    title: decisionSeed.title,
    link: decisionSeed.pin_sha,
    href,
    text: '',
  };
  expect(compareDecision(shown, decisionSeed, 'second factory')).toEqual([]);
  for (const wrong of [
    '/f/second%20factory/versions',
    href.replace('b2b2', 'a1a1'),
    href.replace('second%20factory', 'mission-control'),
    href.replace('5ffd60c6full', 'another-pin'),
  ]) {
    expect(compareDecision({ ...shown, href: wrong }, decisionSeed, 'second factory')).toHaveLength(
      1,
    );
  }
  expect(compareDecision(undefined, decisionSeed, 'second factory')).toHaveLength(4);
});

test('unused pins keep a pin-only link and unmatched decisions must retain their non-link explanation', () => {
  expect(decisionHref({ ...decisionSeed, digest: null }, 'mission-control')).toBe(
    '/f/mission-control/versions?pin=5ffd60c6full',
  );
  const seed = { ...decisionSeed, pin_sha: null, digest: null, version: 'none' };
  const shown = {
    date: seed.date,
    title: seed.title,
    link: null,
    href: null,
    text: 'none, no pin by that prefix',
  };
  expect(compareDecision(shown, seed, 'mission-control')).toEqual([]);
  expect(compareDecision({ ...shown, text: '' }, seed, 'mission-control')).toHaveLength(1);
  expect(
    compareDecision({ ...shown, href: '/f/mission-control/versions' }, seed, 'mission-control'),
  ).toHaveLength(1);
});

test('destination assertions reject an undifferentiated list, wrong target, hidden target and comparison selection', () => {
  const target = {
    pin: decisionSeed.pin_sha,
    digest: decisionSeed.digest,
    kind: 'version',
    text: '5ffd60c6 sha256:b2b2',
    visible: true,
    highlighted: true,
  };
  const shown = {
    href: decisionHref(decisionSeed, 'mission-control') as string,
    factory: 'mission-control',
    targets: [target],
    selected: 0,
  };
  expect(compareDecisionDestination(shown, decisionSeed, 'mission-control')).toEqual([]);
  for (const bad of [
    { ...shown, targets: [] },
    { ...shown, targets: [target, target] },
    { ...shown, targets: [{ ...target, pin: 'wrong' }] },
    { ...shown, targets: [{ ...target, digest: 'sha256:a1a1' }] },
    { ...shown, targets: [{ ...target, visible: false }] },
    { ...shown, targets: [{ ...target, highlighted: false }] },
    { ...shown, targets: [{ ...target, text: '' }] },
    { ...shown, selected: 1 },
    { ...shown, href: '/f/mission-control/versions' },
    { ...shown, factory: 'second-factory' },
  ])
    expect(compareDecisionDestination(bad, decisionSeed, 'mission-control').length).toBeGreaterThan(
      0,
    );
  const unused = { ...decisionSeed, digest: null };
  const pending = {
    ...shown,
    href: decisionHref(unused, 'mission-control') as string,
    targets: [{ ...target, digest: null, kind: 'pending', text: '5ffd60c6 Not yet run' }],
  };
  expect(compareDecisionDestination(pending, unused, 'mission-control')).toEqual([]);
  expect(
    compareDecisionDestination(
      { ...pending, targets: [{ ...pending.targets[0], kind: 'version' }] },
      unused,
      'mission-control',
    ),
  ).toHaveLength(1);
  expect(
    compareDecisionDestination(
      { ...pending, targets: [{ ...pending.targets[0], text: '5ffd60c6' }] },
      unused,
      'mission-control',
    ),
  ).toHaveLength(1);
});

const destinationSeeds = [
  decisionSeed,
  { ...decisionSeed, title: 'Another version', pin_sha: 'other-pin', digest: 'sha256:other' },
  { ...decisionSeed, title: 'Unused pin', pin_sha: 'unused-pin', digest: null },
  { ...decisionSeed, title: 'Unmatched', pin_sha: null, digest: null, version: 'none' },
];

type ObservationFault =
  | 'timeline'
  | 'destination'
  | 'goto'
  | 'evaluate'
  | 'screenshot'
  | 'viewport';

function destinationPage(fault?: ObservationFault, closeFails = false) {
  const visits: { url: string; width: number }[] = [];
  const observations: { factory: string; pin: string | null; width: number }[] = [];
  let width = 0;
  let url = new URL('http://localhost:8850');
  let closed = false;
  let failed = false;
  const rejectOnce = (at: ObservationFault) => {
    if (fault !== at || failed) return false;
    failed = true;
    return true;
  };
  const page: Page = {
    async setViewport(value) {
      if (rejectOnce('viewport')) throw new Error('viewport rejected');
      width = value;
    },
    async goto(value) {
      visits.push({ url: value, width });
      if (rejectOnce('goto')) throw new Error('navigation rejected');
      url = new URL(value);
    },
    async evaluate<T>(expression: string): Promise<T> {
      if (rejectOnce('evaluate')) throw new Error('evaluation rejected');
      const factory = decodeURIComponent(url.pathname.split('/')[2]);
      let value: unknown;
      if (expression.includes('data-state="ready"')) {
        value = !rejectOnce(expression.includes('decisions-timeline') ? 'timeline' : 'destination');
      } else if (expression.includes('.click()')) {
        const index = Number(expression.match(/\)\[(\d+)\]/)?.[1]);
        const href = decisionHref(destinationSeeds[index], factory);
        if (href === null) throw new Error('unmatched decision was clicked');
        url = new URL(href, url);
      } else if (expression.includes('getBoundingClientRect')) {
        const seed = destinationSeeds.find((row) => row.pin_sha === url.searchParams.get('pin'));
        if (!seed) throw new Error('unknown destination');
        observations.push({ factory, pin: seed.pin_sha, width });
        value = {
          href: url.pathname + url.search,
          factory,
          selected: 0,
          targets: [
            {
              pin: seed.pin_sha,
              digest: seed.digest,
              kind: seed.digest === null ? 'pending' : 'version',
              text: `${seed.pin_sha} ${seed.digest ?? 'Not yet run'}`,
              visible: true,
              highlighted: true,
            },
          ],
        };
      } else if (expression.includes('data-date')) {
        value = destinationSeeds.map((seed) => ({
          date: seed.date,
          title: seed.title,
          link: seed.pin_sha,
          href: decisionHref(seed, factory),
          text: `${seed.version}, no pin by that prefix`,
        }));
      }
      return value as T;
    },
    async screenshot(value) {
      expect(value).toBe(width);
      if (rejectOnce('screenshot')) throw new Error('screenshot rejected');
      return Buffer.from('recorded image');
    },
    async close() {
      closed = true;
      if (closeFails) throw new Error('close rejected');
    },
  };
  return { page, visits, observations, closed: () => closed };
}

function destinationDb(queryFault?: string) {
  const calls: { sql: string; params: unknown[] | undefined }[] = [];
  const db: Db = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (queryFault && sql.includes(queryFault)) throw new Error('query rejected');
      if (sql.includes('FROM mc.decisions')) return destinationSeeds;
      if (sql.includes('SELECT digest, first_run_at')) {
        return destinationSeeds
          .filter((s) => s.digest !== null)
          .map((s) => ({
            digest: s.digest,
            first_run_at: '2026-10-10T00:00:00Z',
          }));
      }
      return [];
    },
    transaction: async (fn) => fn(db),
    close: async () => {},
  };
  return { db, calls };
}

test('destination phase measures click and copied URLs at both widths for both factories', async () => {
  const out = scratchRepo();
  const { db, calls } = destinationDb();
  const recorder = destinationPage();
  expect(
    await decisionDestinationPhase(
      async () => recorder.page,
      db,
      'mission-control',
      'http://localhost:8850',
      out,
    ),
  ).toEqual([]);
  for (const factory of ['mission-control', 'second-factory']) {
    for (const width of [1440, 390]) {
      expect(
        recorder.observations.filter((o) => o.factory === factory && o.width === width),
      ).toHaveLength(6);
      for (const seed of destinationSeeds.filter((s) => s.pin_sha !== null)) {
        expect(recorder.visits).toContainEqual({
          url: `http://localhost:8850${decisionHref(seed, factory)}`,
          width,
        });
      }
    }
    const dir = factory === 'mission-control' ? out : join(out, factory);
    expect(readFileSync(join(dir, 'decision-destinations-check.txt'), 'utf8')).toContain(
      'mismatches: 0',
    );
    for (const width of [1440, 390])
      for (const mode of ['click', 'direct']) {
        expect(existsSync(join(dir, `decision-destination-3-${width}-${mode}.png`))).toBe(true);
      }
  }
  expect(recorder.visits.every((visit) => visit.width === 1440 || visit.width === 390)).toBe(true);
  const inserts = calls.filter((c) => c.sql.includes('INSERT INTO mc.laps'));
  expect(inserts).toHaveLength(2);
  expect(inserts.every((c) => c.params?.[1] === 'second-factory')).toBe(true);
  expect(
    calls.filter((c) => c.sql.includes('DELETE FROM mc.laps')).map((c) => c.params?.[0]),
  ).toEqual(inserts.map((c) => c.params?.[0]));
  expect(recorder.closed()).toBe(true);
});

test('destination phase refuses coverage without two distinct joined pins', async () => {
  const { db } = destinationDb();
  db.query = async () => [destinationSeeds[0], ...destinationSeeds.slice(2)];
  const failures = await decisionDestinations(
    destinationPage().page,
    db,
    'mission-control',
    'http://localhost:8850',
    scratchRepo(),
  );
  expect(failures).toEqual(['fewer than two distinct joined pins exercised']);
});

for (const [fault, message] of [
  ['timeline', 'timeline did not become ready'],
  ['destination', 'versions destination did not become ready'],
  ['goto', 'navigation rejected'],
  ['evaluate', 'evaluation rejected'],
  ['screenshot', 'screenshot rejected'],
  ['viewport', 'viewport rejected'],
] as const) {
  test(`destination ${fault} failure stays red and continues to unused and unmatched decisions`, async () => {
    const out = scratchRepo();
    const { db } = destinationDb();
    const recorder = destinationPage(fault);
    const failures = await decisionDestinations(
      recorder.page,
      db,
      'mission-control',
      'http://localhost:8850',
      out,
    );
    expect(failures).toEqual([`mission-control 1440px click decision 1 (Drop briefs): ${message}`]);
    expect(recorder.observations.some((o) => o.pin === 'unused-pin')).toBe(true);
    const report = readFileSync(join(out, 'decision-destinations-check.txt'), 'utf8');
    expect(report).toContain(failures[0]);
    expect(report).toContain('Unmatched');
    expect(report).toContain('mismatches: 1');
  });
}

test('report and close errors retain prior failures and the next factory still runs', async () => {
  const out = scratchRepo();
  mkdirSync(join(out, 'decision-destinations-check.txt'));
  const first = destinationPage('goto', true);
  const second = destinationPage();
  let opens = 0;
  const failures = await decisionDestinationPhase(
    async () => (++opens === 1 ? first.page : second.page),
    destinationDb().db,
    'mission-control',
    'http://localhost:8850',
    out,
  );
  expect(failures).toHaveLength(3);
  expect(failures[0]).toContain('navigation rejected');
  expect(failures[1]).toContain('mission-control destination report:');
  expect(failures[2]).toContain('mission-control destination close: close rejected');
  expect(first.closed()).toBe(true);
  expect(second.observations).toHaveLength(12);
  expect(second.closed()).toBe(true);
});

test('browser startup and seed query failures return to independent work', async () => {
  for (const fault of ['startup', 'query', 'fixture', 'cleanup']) {
    const recorder = destinationPage();
    let opens = 0;
    const { db } = destinationDb(
      fault === 'query'
        ? 'FROM mc.decisions'
        : fault === 'fixture'
          ? 'INSERT INTO mc.laps'
          : fault === 'cleanup'
            ? 'DELETE FROM mc.laps'
            : undefined,
    );
    const failures = await decisionDestinationPhase(
      async () => {
        opens++;
        if (fault === 'startup' && opens === 1) throw new Error('startup rejected');
        return recorder.page;
      },
      db,
      'mission-control',
      'http://localhost:8850',
      scratchRepo(),
    );
    expect(failures.length).toBeGreaterThan(0);
    expect(failures.join('\n')).toContain(
      fault === 'startup' ? 'startup rejected' : 'query rejected',
    );
    expect(recorder.closed()).toBe(true);
    if (fault === 'startup') expect(recorder.observations).toHaveLength(12);
  }
});
