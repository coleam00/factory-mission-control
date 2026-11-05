import { expect, test } from 'bun:test';
import { LANE_STEPS } from '../lib/lap-graph';
import { allCards, cardsCounting, FACTORY_MAP, LISTS, type List, stepPath } from './factory-map';
import {
  type CardLive,
  cardLive,
  deepestStep,
  gateOutcomes,
  type HomeMapRow,
  latestDeploy,
  type MapRightNowRow,
  mergedToday,
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
const DELIVER_VIEW = FACTORY_MAP.views?.['build/deliver']?.cards ?? [];

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

test('a split lap counts on Break it up, an intake triage lap on Triage, a backlog authorize lap on File the issues', () => {
  const SPLIT_VIEW = FACTORY_MAP.views?.split?.cards ?? [];
  const INTAKE_VIEW = FACTORY_MAP.views?.intake?.cards ?? [];
  const rows = [
    lap('split', ['slice'], 'archon-split'),
    lap('tri', ['triage__triage'], 'archon-intake'),
    lap('auth', ['authorize'], 'archon-backlog'),
  ];
  expect(here(rows)).toEqual({ split: ['auth', 'split'], intake: ['tri'] });
  expect(hereOn(rows, SPLIT_VIEW)).toEqual({ 's-slice': ['split'], 's-pub': ['auth'] });
  expect(hereOn(rows, INTAKE_VIEW)).toEqual({ 'i-tri': ['tri'] });
});

test('the open product documents are listed on Split and Keep the document alone: unavailable on error, never empty', () => {
  const document = { number: 410, title: 'T', url: 'u', total_count: 4, merged_count: 2 };
  const of = (sources: Partial<Parameters<typeof cardLive>[1]>) =>
    cardLive(FACTORY_MAP, { map: [], ...sources }, new Date());
  const listed = [...of({ documents: [document] })]
    .filter(([, live]) => live.documents !== undefined)
    .map(([id]) => id);
  expect(listed.sort()).toEqual(['s-keep', 'split']);
  for (const id of ['split', 's-keep']) {
    expect(of({ documents: [document], states: { documents: 'error' } }).get(id)).toEqual({
      here: [],
      listsUnavailable: ['documents'],
    });
  }
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

test('a step counts on its own card in the Deliver view, and review on the Review card as well', () => {
  const rows = [
    lap('impl', ['ship__deliver__rounds.implement__implement', 'ship'], 'archon-build-queue'),
    lap('ci', ['ship__deliver__rounds__ci', 'ship'], 'archon-build-queue'),
    lap('rev', ['ship__deliver__rounds.review__policy', 'ship'], 'archon-build-queue'),
  ];
  expect(hereOn(rows, DELIVER_VIEW)).toEqual({
    'd-impl': ['impl'],
    'd-ci': ['ci'],
    'd-rev': ['rev'],
  });
});

test('the shared counting rule puts a review lap on the Deliver Review card, for the live oracle too', () => {
  const ids = cardsCounting(
    FACTORY_MAP,
    'archon-build-queue',
    stepPath('ship__deliver__rounds.review__policy'),
  ).map((card) => card.id);
  expect(ids).toContain('d-rev');
});

const right = (over: Partial<MapRightNowRow>): MapRightNowRow => ({
  kind: 'outcomes',
  run_id: 'r1',
  at: new Date('2026-10-24T09:00:00Z'),
  decisions: null,
  merged: '[]',
  asked: null,
  claimed: JSON.stringify([1, 2, 3, 4, 5, 6, 7, 8].map((number) => ({ pr: { number } }))),
  revision: null,
  health: null,
  status: null,
  repository: 'o/r',
  ...over,
});
const decision = (number: number, action: string) => ({ number, action, reason: `why ${number}` });

test("the gate lists merged as read back, the sweep's send-backs, an ask only when raised, and a number once", () => {
  const run = right({
    decisions: JSON.stringify([
      decision(1, 'return'),
      decision(2, 'merged'),
      decision(3, 'ask'),
      decision(4, 'ask'),
      decision(5, 'wait'),
      { number: 6, action: 'merged' },
      { number: 3, action: 'return', reason: 'again' },
    ]),
    merged: '[1, 7]',
    asked: '3',
  });
  expect(gateOutcomes([run]).map((o) => [o.number, o.outcome, o.reason])).toEqual([
    [1, 'merged', 'why 1'],
    [3, 'sweep: asked', 'why 3'],
  ]);
  const returned = right({ decisions: JSON.stringify([decision(8, 'return')]) });
  expect(gateOutcomes([returned])[0]).toMatchObject({
    outcome: 'sweep: sent back',
    url: 'https://github.com/o/r/pull/8',
  });
  const stray = right({
    decisions: JSON.stringify([decision(9, 'return')]),
    claimed: JSON.stringify([{ pr: { number: 8 } }]),
  });
  expect(gateOutcomes([stray])).toEqual([]);
  expect(gateOutcomes([right({ decisions: 'not json' }), right({ decisions: '{}' })])).toEqual([]);
});

test('the gate lists the newest run first', () => {
  const old = right({ run_id: 'old', decisions: JSON.stringify([decision(1, 'return')]) });
  const newer = right({
    run_id: 'new',
    at: new Date('2026-10-25T09:00:00Z'),
    decisions: JSON.stringify([decision(2, 'return')]),
  });
  expect(gateOutcomes([old, newer]).map((o) => o.run)).toEqual(['new', 'old']);
});

test('the latest deploy is the newest of the queue and the old loop, and null when there is none', () => {
  expect(latestDeploy([right({})])).toBeNull();
  const queue = right({ kind: 'deploys', run_id: 'q', revision: 'a', status: 'verified' });
  const loop = right({
    kind: 'deploys',
    run_id: 'l',
    at: new Date('2026-10-26T09:00:00Z'),
    revision: 'b',
    status: 'failed',
  });
  expect(latestDeploy([queue, loop])).toMatchObject({ run: 'l', revision: 'b', verified: false });
});

test('a deploy counts as read back only when its status is verified', () => {
  const deploy = (status: 'deployed' | 'verified') =>
    right({ kind: 'deploys', run_id: 'l', revision: 'b', status });
  expect(latestDeploy([deploy('deployed')])).toMatchObject({ verified: true, readBack: false });
  expect(latestDeploy([deploy('verified')])).toMatchObject({ verified: true, readBack: true });
});

test('Merge gate lists the gate, the Staging cards the deploy and open work orders, and an error is unavailable', () => {
  const order = {
    name: 'combat',
    total_count: 3,
    open_count: 2,
    merged_count: 1,
    lands_on: 'staging',
    last_closed_at: null,
  };
  const closed = { ...order, name: 'done', open_count: 0 };
  const sources = { map: [], orders: [order, closed], rightNow: [right({})] };
  const live = cardLive(FACTORY_MAP, sources, new Date());
  expect(live.get('m-gate')?.gate).toEqual([]);
  expect(live.get('y-ver')?.deploy).toBeNull();
  expect(live.get('y-ver')?.lands).toEqual([order]);
  expect(live.get('y-dep')?.orders).toBeUndefined();

  const failed = cardLive(FACTORY_MAP, { ...sources, states: { rightNow: 'error' } }, new Date());
  expect(failed.get('m-gate')).toEqual({ here: [], listsUnavailable: ['outcomes'] });
  expect(failed.get('y-ver')?.listsUnavailable).toEqual(['deploys']);
  expect(failed.get('y-ver')?.lands).toEqual([order]);
});

// Typed over List: a list added to LISTS fails tsc here until it is named, and fails below until live.ts routes it.
const LIST_FIELD: Record<List, keyof CardLive> = {
  documents: 'documents',
  outcomes: 'gate',
  deploys: 'deploy',
  lands: 'lands',
};

test.each(LISTS)('a card listing %s is filled in its own field', (list) => {
  const sources = { map: [], documents: [], orders: [], rightNow: [right({})] };
  const live = cardLive(FACTORY_MAP, sources, new Date());
  const cards = allCards(FACTORY_MAP).filter((card) => card.lists?.includes(list));
  expect(cards.length).toBeGreaterThan(0);
  for (const card of cards) {
    expect(live.get(card.id)?.[LIST_FIELD[list]]).not.toBeUndefined();
  }
});
