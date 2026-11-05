import { expect, test } from 'bun:test';
import type { HealthStepRow } from '../lib/health';
import { LANE_STEPS } from '../lib/lap-graph';
import { FACTORY_MAP } from './factory-map';
import {
  cardLive,
  deepestStep,
  type HomeMapRow,
  mergedToday,
  overdueHealth,
  versionRecorded,
} from './live';

const lap = (
  run: string,
  steps: string[] | null,
  workflow = 'archon-loop',
  number: number | null = null,
): HomeMapRow => ({
  kind: 'lap',
  run_id: run,
  workflow,
  steps,
  number,
  title: number === null ? null : `issue ${number}`,
  url: null,
  at: null,
  prs: null,
});

const hereOn = (rows: HomeMapRow[], cards: readonly { id: string }[]) => {
  const ids = new Set(cards.map((c) => c.id));
  return Object.fromEntries(
    [...cardLive(FACTORY_MAP, { map: rows }, new Date()).entries()]
      .filter(([id, live]) => ids.has(id) && live.here.length > 0)
      .map(([id, live]) => [id, live.here.map((l) => l.run)]),
  );
};

/** The home map's cards only; `BUILD_VIEW` has the Build view's. */
const here = (rows: HomeMapRow[]) => hereOn(rows, FACTORY_MAP.cards);
const BUILD_VIEW = FACTORY_MAP.views?.build?.cards ?? [];

test('a lap counts once, on the card covering its deepest running step', () => {
  expect(
    here([
      lap('a', ['check-app'], 'archon-loop', 7),
      lap('b', ['ship__deliver__rounds__review__code', 'ship__deliver__rounds', 'ship']),
      lap('c', ['ship__deliver__rounds__implement__implement']),
      lap('d', ['deploy__health']),
      lap('e', ['slice'], 'archon-backlog'),
      lap('f', ['manage'], 'archon-manager'),
      lap('g', ['write'], 'archon-holdouts'),
      lap('h', ['claim']),
    ]),
  ).toEqual({
    split: ['e'],
    mgr: ['f'],
    intake: ['h'],
    build: ['c'],
    review: ['b'],
    app: ['a'],
    deploy: ['d'],
  });
});

test("a lap running on any step a lane marks counts on a card, so the cards' laps sum to the header's", () => {
  const rows = LANE_STEPS.flatMap((mark) => mark.split('/')).map((step) => lap(step, [step]));
  const counted = Object.values(here(rows)).flat();
  expect(counted.sort()).toEqual(rows.map((r) => r.run_id as string).sort());
  expect(here([lap('a', ['handoff'])])).toEqual({ app: ['a'] });
});

test('a lap with no running step, on a step no card covers, or of another workflow is on no card', () => {
  expect(
    here([lap('a', null), lap('b', ['tally']), lap('c', ['check-app'], 'archon-validate')]),
  ).toEqual({});
});

test('of steps as deep, the newest (first) counts', () => {
  expect(deepestStep(['land', 'review'])).toBe('land');
  expect(deepestStep(['review', 'ship__deliver'])).toBe('ship__deliver');
  expect(deepestStep([])).toBeUndefined();
});

test("a loop group's iteration of a step counts on the card covering that step", () => {
  expect(
    here([
      lap('policy', ['ship__deliver__rounds.review__policy', 'ship__deliver__rounds', 'ship']),
      lap('rereview', ['ship__deliver__rounds.rereview__scope']),
      lap('implement', ['ship__deliver__rounds.implement__implement']),
    ]),
  ).toEqual({ review: ['policy', 'rereview'], build: ['implement'] });
  expect(deepestStep(['ship__deliver__rounds', 'ship__deliver__rounds.review__policy'])).toBe(
    'ship__deliver__rounds.review__policy',
  );
});

const merged = (run: string, at: Date | null): HomeMapRow => ({
  ...lap(run, null, 'archon-loop', 3),
  kind: 'merged',
  at,
});

test("merged counts the land steps that merged on the browser's local day, newest first", () => {
  const now = new Date(2026, 10, 3, 15, 0);
  expect(
    mergedToday(
      [
        merged('morning', new Date(2026, 10, 3, 0, 5)),
        merged('noon', new Date(2026, 10, 3, 12, 0)),
        merged('yesterday', new Date(2026, 10, 2, 23, 59)),
        { ...lap('running', ['deploy'], 'archon-loop', 4), at: new Date(2026, 10, 3, 9, 0) },
        merged('unfinished', null),
      ],
      now,
    ).map((m) => m.run),
  ).toEqual(['noon', 'morning']);
});

test('each chip sits on the card that carries it, and a source not delivered yet draws none', () => {
  const failing: HomeMapRow = {
    kind: 'failing',
    run_id: null,
    workflow: null,
    steps: null,
    number: 109,
    title: 'Broken thing',
    url: 'https://github.com/o/r/pull/109',
    at: null,
    prs: null,
  };
  const live = cardLive(
    FACTORY_MAP,
    {
      map: [failing],
      workable: [
        { kind: 'issue', issue_number: 5, title: 'Five', url: null, run_id: null },
        { kind: 'lap', issue_number: null, title: null, url: null, run_id: 'r' },
      ],
      owner: [
        {
          kind: 'question',
          issue_number: 9,
          question_number: 2,
          title: 'Which?',
          url: null,
          options: null,
          recommendation: null,
          default_option: null,
          default_at: null,
          waiting_since: null,
          approximate: false,
        },
      ],
    },
    new Date(),
  );
  expect(live.get('app')?.failing?.map((i) => i.number)).toEqual([109]);
  expect(live.get('build')?.queued?.map((i) => i.number)).toEqual([5]);
  expect(live.get('mgr')?.waiting?.map((i) => i.key)).toEqual(['question-9-2']);
  expect(live.get('out')?.merged).toEqual([]);
  expect(live.get('review')).toEqual({ here: [] });
});

test('the current version is always recorded; a pinned one only when the query names it', () => {
  const version: HomeMapRow = { ...lap('x', null), kind: 'version', run_id: null, workflow: null };
  expect(versionRecorded([], null)).toBe(true);
  expect(versionRecorded([], 'abc')).toBe(false);
  expect(versionRecorded([version], 'abc')).toBe(true);
});

test('a queue run counts on the card covering its deepest step: implement on Build, review on Review', () => {
  expect(
    here([
      lap(
        'impl',
        ['ship__deliver__rounds.implement__implement', 'ship'],
        'archon-build-queue',
        401,
      ),
      lap('rev', ['ship__deliver__rounds.review__policy', 'ship'], 'archon-build-queue', 402),
      lap('rerev', ['ship__deliver__rounds.rereview__scope'], 'archon-build-queue'),
      lap('ask', ['ask'], 'archon-build-queue'),
      lap('sweep', ['sweep'], 'archon-merge-queue'),
      lap('slice', ['slice'], 'archon-split'),
      lap('take', ['triage'], 'archon-intake'),
    ]),
  ).toEqual({
    build: ['ask', 'impl'],
    review: ['rerev', 'rev'],
    merge: ['sweep'],
    split: ['slice'],
    intake: ['take'],
  });
});

test('a run in the old loop keeps its own steps off the queue cards', () => {
  expect(
    here([
      lap('a', ['merge__execute'], 'archon-merge-queue'),
      lap('b', ['resolve-input'], 'archon-discoveries'),
    ]),
  ).toEqual({});
});

const attention = (run: string, number: number | null, title: string | null): HomeMapRow => ({
  ...lap(run, null, 'archon-merge-queue', number),
  kind: 'waiting',
  title,
});
const queues: HomeMapRow = { ...lap('x', null), kind: 'queues', run_id: null, workflow: null };
const ownerRow = {
  kind: 'issue' as const,
  issue_number: 9,
  question_number: null,
  title: 'Needs owner',
  url: null,
  options: null,
  recommendation: null,
  default_option: null,
  default_at: null,
  waiting_since: null,
  approximate: false,
};
const waitingOf = (sources: Parameters<typeof cardLive>[1]) =>
  cardLive(FACTORY_MAP, sources, new Date()).get('mgr');

test('on a factory on the queues, waiting is the attention items alone, whatever the owner source says', () => {
  const map = [
    queues,
    attention('run-with-issue', 404, 'Fix it'),
    attention('abcdef0123', null, null),
  ];
  expect(waitingOf({ map, owner: [ownerRow], states: { owner: 'error' } })?.waiting).toEqual([
    { key: 'attention-run-with-issue', number: 404, title: 'Fix it', url: null },
    {
      key: 'attention-abcdef0123',
      number: null,
      title: 'archon-merge-queue run abcdef01',
      url: null,
    },
  ]);
});

test('on a factory on the old loop, waiting is the owner items, unavailable or absent as before', () => {
  expect(waitingOf({ map: [], owner: [ownerRow] })?.waiting?.map((i) => i.key)).toEqual([
    'issue-9',
  ]);
  expect(waitingOf({ map: [], states: { owner: 'error' } })?.unavailable).toEqual(['waiting']);
  expect(waitingOf({ map: [] })?.waiting).toBeUndefined();
});

test('a merge-queue lap merges each pull request its record read back; a malformed list merges none', () => {
  const now = new Date(2026, 10, 4, 15, 0);
  const at = new Date(2026, 10, 4, 9, 0);
  const queued = (run: string, prs: string): HomeMapRow => ({
    ...lap(run, null, 'archon-merge-queue'),
    kind: 'merged',
    at,
    prs,
  });
  expect(
    mergedToday(
      [
        queued('q', '[404, 405]'),
        queued('bad', 'oops'),
        queued('odd', '[0, "x", 7.5, -1]'),
        queued('obj', '{"a":1}'),
      ],
      now,
    ).map((m) => [m.run, m.number]),
  ).toEqual([
    ['q', 404],
    ['q', 405],
  ]);
  expect(mergedToday([{ ...queued('old', '[]'), prs: null, number: 12 }], now)).toEqual([
    { run: 'old', number: 12, at },
  ]);
});

test('the work orders with an open issue are the chip of the Work order card: absent until answered, unavailable on error', () => {
  const order = {
    name: 'combat',
    total_count: 3,
    open_count: 2,
    merged_count: 1,
    lands_on: 'staging',
    last_closed_at: null,
  };
  const ordersOf = (sources: Partial<Parameters<typeof cardLive>[1]>) =>
    cardLive(FACTORY_MAP, { map: [], ...sources }, new Date()).get('order');
  expect(ordersOf({ orders: [order] })?.orders).toEqual([order]);
  expect(ordersOf({ orders: [] })?.orders).toEqual([]);
  expect(ordersOf({ orders: [{ ...order, open_count: 0 }] })?.orders).toEqual([]);
  expect(ordersOf({})?.orders).toBeUndefined();
  expect(ordersOf({ orders: [order], states: { orders: 'error' } })).toEqual({
    here: [],
    unavailable: ['orders'],
  });
});

test('a run counts once per level: implement on Build and Deliver, review on Review and no Build-view card, ship alone on Write the brief', () => {
  const rows = [
    lap('impl', ['ship__deliver__rounds.implement__implement', 'ship'], 'archon-build-queue'),
    lap('rev', ['ship__deliver__rounds.review__policy', 'ship'], 'archon-build-queue'),
    lap('start', ['ship'], 'archon-build-queue'),
  ];
  expect(here(rows)).toEqual({ build: ['impl', 'start'], review: ['rev'] });
  expect(hereOn(rows, BUILD_VIEW)).toEqual({ 'b-del': ['impl'], 'b-brief': ['start'] });
});

test('a run of the old loop on build counts on Build and Deliver', () => {
  const rows = [lap('old', ['build'], 'archon-loop')];
  expect(here(rows)).toEqual({ build: ['old'] });
  expect(hereOn(rows, BUILD_VIEW)).toEqual({ 'b-del': ['old'] });
});

const MANAGER_VIEW = FACTORY_MAP.views?.manager?.cards ?? [];
const OTHER = new Date('2026-11-05T12:00:00Z');

const asking = (run: string, labels: Record<string, string>, message = '**A question**') => ({
  run_id: run,
  workflow_name: 'archon-build-queue',
  node_id: 'ask',
  waiting_since: new Date('2026-11-05T10:00:00Z'),
  form: 'select',
  options: '[{"id":"ship","label":"Ship it"},{"id":"stop","label":"Stop"}]',
  labels: JSON.stringify(labels),
  message,
  console: 'http://archon.test',
});

test("the Manager view's question cards each count the open items their label names, the Manager the rest", () => {
  const live = cardLive(
    FACTORY_MAP,
    {
      map: [],
      attention: [
        asking('r1', { build: 'scope' }),
        asking('r2', { build: 'size' }),
        asking('r3', { merge: 'risky' }),
        asking('r4', { discoveries: 'question' }),
        asking('r5', { stage: 'archon-triage' }),
        asking('r6', { stage: 'archon-review' }),
        asking('r7', {}, '**Other**\n\n**Recommendation: `stop`**'),
      ],
    },
    OTHER,
  );
  const counts = Object.fromEntries(
    MANAGER_VIEW.map((card) => [card.id, live.get(card.id)?.waiting?.map((i) => i.key)]),
  );
  expect(counts).toEqual({
    'u-c': ['attention-r5'],
    'u-b': ['attention-r1', 'attention-r2'],
    'u-m': ['attention-r3'],
    'u-d': ['attention-r4'],
    'u-mgr': ['attention-r6', 'attention-r7'],
    'u-pol': undefined,
  });
  const questions = live.get('u-mgr')?.questions ?? [];
  expect(questions).toHaveLength(7);
  expect(questions.at(-1)).toMatchObject({
    title: 'Other',
    url: 'http://archon.test/console/r/r7',
    note: 'recommends Stop',
  });
});

test('a failed attention query makes the question cards unavailable, not zero', () => {
  const live = cardLive(FACTORY_MAP, { map: [], states: { attention: 'error' } }, OTHER);
  expect(live.get('u-b')?.unavailable).toEqual(['waiting']);
  expect(live.get('u-b')?.waiting).toBeUndefined();
});

test('a failed attention query keeps no stale counts or questions', () => {
  const live = cardLive(
    FACTORY_MAP,
    { map: [], attention: [asking('r1', { build: 'scope' })], states: { attention: 'error' } },
    OTHER,
  );
  expect(live.get('u-b')).toMatchObject({ unavailable: ['waiting'] });
  expect(live.get('u-b')?.waiting).toBeUndefined();
  expect(live.get('u-mgr')?.questions).toBeUndefined();
});

test('a running step past twice its usual time is an overdue item linking its run', () => {
  const at = (ms: number) => new Date(OTHER.getTime() - ms);
  const step = (run: string, kind: 'running' | 'completion', ms: number, started: number) => ({
    run_id: run,
    workflow_name: 'archon-build-queue',
    step_id: 'build',
    kind,
    at: at(started),
    duration_ms: ms,
    console: kind === 'running' ? 'http://archon.test' : null,
  });
  const rows = [
    ...['c1', 'c2', 'c3'].map((run) => step(run, 'completion', 60_000, 3_600_000)),
    step('slow', 'running', 0, 3_600_000),
    step('fresh', 'running', 0, 30_000),
  ] satisfies HealthStepRow[];
  expect(overdueHealth(rows, OTHER.getTime())).toMatchObject([
    { key: 'health-overdue-slow-build', run: 'slow', url: 'http://archon.test/console/r/slow' },
  ]);
});

test("the Manager's Right now lists the factory's health by the Health screen's definitions, with console links", () => {
  const run = (id: string, status: string, error: string | null = null) => ({
    run_id: id,
    workflow_name: 'archon-build-queue',
    status,
    started_at: null,
    completed_at: null,
    failed_step: error === null ? null : 'build',
    error,
    failed_at: null,
    console: 'http://archon.test',
  });
  const live = cardLive(
    FACTORY_MAP,
    {
      map: [],
      healthRuns: [run('p1', 'paused'), run('f1', 'failed', 'HTTP 429')],
      healthSteps: [],
    },
    OTHER,
  );
  expect(live.get('u-mgr')?.health).toEqual([
    {
      key: 'health-paused-p1',
      note: 'paused: archon-build-queue',
      run: 'p1',
      url: 'http://archon.test/console/r/p1',
    },
    {
      key: 'health-failed-f1',
      note: 'failed: Usage limit',
      run: 'f1',
      url: 'http://archon.test/console/r/f1',
    },
  ]);
  const failed = cardLive(FACTORY_MAP, { map: [], states: { healthRuns: 'error' } }, OTHER);
  expect(failed.get('u-mgr')?.healthUnavailable).toBe(true);
});
