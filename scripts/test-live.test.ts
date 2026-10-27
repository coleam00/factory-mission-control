import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from './lib/cdp';
import { REPO_ROOT } from './lib/cli';
import type { Db } from './lib/db';
import { NOW, recordingDeps, scratchRepo } from './lib/test-deps';
import { emptyPanelTimings } from './live/timings';
import {
  compareDecision,
  compareDecisionDestination,
  compareScorecard,
  decisionDestinationPhase,
  decisionDestinations,
  decisionHref,
  freePort,
  LIMITS,
  lateWrite,
  main,
  observeHomePanels,
  parseRealtimeFeatures,
  type ShownCell,
} from './test-live';

test.each(['timeout', 'error state', 'evaluation throws', 'ready'])(
  'home observations retain the ready strip when the map is %s',
  async (mapState) => {
    const panels = ['status-strip', 'home-map'].map((query) => ({
      query,
      name: query,
      selector: `[data-live="${query}"]`,
      timings: emptyPanelTimings(),
    }));
    const calls: string[] = [];
    const page: Page = {
      async evaluate<T>(expression: string): Promise<T> {
        const query = expression.includes('status-strip') ? 'status-strip' : 'home-map';
        if (expression.includes('document.querySelector')) {
          calls.push(`ready:${query}`);
          if (query === 'home-map') {
            if (mapState === 'evaluation throws') throw new Error('evaluation failed');
            return (mapState === 'ready') as T;
          }
          return true as T;
        }
        calls.push(`marks:${query}`);
        return {
          [query]: {
            readyAt: 125,
            sentAt: 100,
            firstAt: 110,
            renderedAt: 125,
            subscribedAt: 100,
            context: {
              id: query,
              query,
              factory: 'factory-a',
              args: [],
              home: false,
              branch: null,
              queryFingerprint: 'fingerprint',
            },
          },
        } as T;
      },
      async goto() {},
      async setViewport() {},
      async screenshot() {
        return Buffer.alloc(0);
      },
      async close() {},
    };
    const observing = observeHomePanels(page, panels);
    if (mapState === 'ready') await observing;
    else
      await expect(observing).rejects.toThrow(
        mapState === 'evaluation throws' ? 'evaluation failed' : 'home-map did not reach',
      );
    const persisted = JSON.parse(JSON.stringify(panels.map((panel) => panel.timings)));
    expect(persisted[0]).toMatchObject({
      readyMs: 125,
      firstSnapshotMs: 25,
      subscribeToFirstResultMs: 10,
      renderMs: 15,
      queryExecutionMs: null,
    });
    expect(persisted[1].readyMs).toBe(mapState === 'ready' ? 125 : null);
    expect(calls).toEqual([
      'ready:status-strip',
      'marks:status-strip',
      'ready:home-map',
      ...(mapState === 'ready' ? ['marks:home-map'] : []),
    ]);
  },
);

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

test('REALTIME.md gives test:live a probe and a verdict for each feature the live queries rely on', () => {
  const features = parseRealtimeFeatures(
    readFileSync(join(REPO_ROOT, 'db', 'queries', 'REALTIME.md'), 'utf-8'),
  );
  const names = features.map((f) => f.feature);
  for (const name of [
    'CTE',
    'LATERAL',
    'DISTINCT ON',
    'window function',
    'LEFT JOIN LATERAL',
    'UNION ALL',
    'NOT EXISTS',
    'starts_with()',
    'EXISTS in CASE',
  ]) {
    expect(names).toContain(name);
  }
  for (const f of features) {
    expect(f.probe).toMatch(/^(SELECT|WITH)\b/);
    expect(f.verdict === 'rejected').toBe(f.error !== '');
  }
});

test('the scorecard comparison counts a number missing from the screen as a mismatch', () => {
  const cell = (measure: string, value: string, over: Partial<ShownCell> = {}): ShownCell => ({
    digest: 'sha256:a1',
    measure,
    value,
    laps: '12',
    listed: 12,
    summary: '12 laps',
    ...over,
  });
  const expected = {
    versions: [
      {
        digest: 'sha256:a1',
        measures: {
          merges: { value: 3, laps: 12 },
          cost_per_merge: { value: null, laps: 12 },
          send_backs: { value: 2, laps: 12 },
          empty_laps: { value: 1, laps: 12 },
        },
      },
    ],
  };
  const { comparisons, mismatches, lapListFailures } = compareScorecard(
    [
      cell('merges', '3.0000'),
      cell('cost_per_merge', 'n/a'),
      cell('send_backs', '2.0000', { laps: '11', listed: 11, summary: '11 laps' }),
      cell('laps', '12.0000', { listed: 11 }),
    ],
    expected,
  );
  expect(comparisons.map((c) => [c.measure, c.match])).toEqual([
    ['merges', true],
    ['cost_per_merge', true],
    ['send_backs', false],
    ['empty_laps', false],
  ]);
  expect(mismatches).toBe(2);
  expect(lapListFailures).toHaveLength(1);
  expect(lapListFailures[0]).toContain('laps: data-laps 12, lists 11');
});

/**
 * `main` over deps with no check branch, so `test:live` fails at its first step (reading
 * `MC_DATABASE_URL`) and records whether this process held the lock at that moment.
 */
function lockedRun(options: { holder?: number; onSleep?: (sleeps: number) => void } = {}) {
  const lock = join(scratchRepo(), 'test-live.lock');
  if (options.holder !== undefined) {
    writeFileSync(lock, `${JSON.stringify({ pid: options.holder, since: NOW.toISOString() })}\n`);
  }
  const heldDuringWork: (number | undefined)[] = [];
  const env = new Proxy<Record<string, string | undefined>>(
    { MC_TEST_LIVE_LOCK: lock },
    {
      get(target, key: string) {
        if (key === 'MC_DATABASE_URL') {
          heldDuringWork.push(
            existsSync(lock) ? JSON.parse(readFileSync(lock, 'utf-8')).pid : undefined,
          );
        }
        return target[key];
      },
    },
  );
  const recorder = recordingDeps({ repoRoot: scratchRepo(), env });
  recorder.deps.env = env;
  let clock = NOW.getTime();
  let sleeps = 0;
  recorder.deps.now = () => new Date(clock);
  recorder.deps.sleep = async (ms) => {
    sleeps += 1;
    clock += ms;
    options.onSleep?.(sleeps);
  };
  return { lock, recorder, heldDuringWork, sleeps: () => sleeps };
}

const NOT_SET = 'MC_DATABASE_URL is not set: run `bun run fixture:branch` first';

test('test:live takes a free lock before it starts and releases it when it fails', async () => {
  const { lock, recorder, heldDuringWork } = lockedRun();
  expect(await main([], recorder.deps)).toBe(1);
  expect(heldDuringWork).toEqual([process.pid]);
  expect(existsSync(lock)).toBe(false);
  expect(recorder.err).toEqual([NOT_SET]);
  expect(recorder.out).toEqual([]);
});

test('test:live waits for a live holder, naming its process id, then runs once it lets go', async () => {
  const holder = process.ppid;
  const run = lockedRun({
    holder,
    onSleep: (sleeps) => {
      if (sleeps === 3) rmSync(run.lock);
    },
  });
  expect(await main([], run.recorder.deps)).toBe(1);
  expect(run.sleeps()).toBe(3);
  expect(run.recorder.out).toEqual([
    `waiting for test:live lock ${run.lock}, held by process ${holder} (up to 30 min)`,
    `took test:live lock ${run.lock}`,
  ]);
  expect(run.heldDuringWork).toEqual([process.pid]);
  expect(existsSync(run.lock)).toBe(false);
});

test('test:live takes over a lock left by a process that no longer exists', async () => {
  const gone = Bun.spawn([process.execPath, '-e', '0']);
  await gone.exited;
  const { lock, recorder, heldDuringWork, sleeps } = lockedRun({ holder: gone.pid });
  expect(await main([], recorder.deps)).toBe(1);
  expect(sleeps()).toBe(0);
  expect(recorder.out).toEqual([
    `test:live lock ${lock} was left by process ${gone.pid}, which no longer exists: taking it over`,
  ]);
  expect(heldDuringWork).toEqual([process.pid]);
  expect(existsSync(lock)).toBe(false);
});

test('test:live gives up after 30 minutes, naming the holder, and leaves its lock alone', async () => {
  const holder = process.ppid;
  const { lock, recorder, heldDuringWork } = lockedRun({ holder });
  expect(await main([], recorder.deps)).toBe(1);
  expect(heldDuringWork).toEqual([]);
  expect(recorder.err).toEqual([
    `test:live lock ${lock} is still held by process ${holder} after 30 min: another test:live is running on this machine`,
  ]);
  expect(JSON.parse(readFileSync(lock, 'utf-8')).pid).toBe(holder);
});

test('the usage text says test:live runs one at a time per machine', async () => {
  const { recorder } = lockedRun();
  expect(await main(['--help'], recorder.deps)).toBe(0);
  expect(recorder.out.join('\n')).toContain('Runs one at a time per machine');
});

test('freePort waits while every port in 8850-8864 is taken and takes the first one freed', async () => {
  const lines: string[] = [];
  let clock = 0;
  const deps = {
    now: () => new Date(clock),
    sleep: async (ms: number) => {
      clock += ms;
    },
    out: (line: string) => lines.push(line),
  };
  const port = await freePort(deps, { pollMs: 1000, free: (p) => p === 8857 && clock >= 3000 });
  expect(port).toBe(8857);
  expect(lines).toEqual([
    'every port in 8850-8864 is taken: waiting for one (up to 30 min)',
    'port 8857 is free',
  ]);
});

test('freePort gives up once its wait runs out', async () => {
  let clock = 0;
  const deps = {
    now: () => new Date(clock),
    sleep: async (ms: number) => {
      clock += ms;
    },
    out: () => {},
  };
  await expect(freePort(deps, { waitMs: 120_000, free: () => false })).rejects.toThrow(
    'no free port in 8850-8864 after 2 min',
  );
});

test('a missing or late write names its reading and its value', () => {
  const limit = LIMITS.insertToScreenMs;
  expect(lateWrite('the pin before the hold (pinToScreenMs)', 'the versions screen', null)).toEqual(
    [
      `the pin before the hold (pinToScreenMs) never reached the versions screen within ${limit} ms`,
    ],
  );
  expect(lateWrite('label first', 'the issues screen', undefined)).toEqual([
    `label first never reached the issues screen within ${limit} ms`,
  ]);
  expect(lateWrite('a pin', 'the versions screen', limit + 1)).toEqual([
    `a pin reached the versions screen after ${limit + 1} ms, limit ${limit}`,
  ]);
  expect(lateWrite('a pin', 'the versions screen', limit)).toEqual([]);
});
