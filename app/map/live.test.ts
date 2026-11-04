import { expect, test } from 'bun:test';
import { LANE_STEPS } from '../lib/lap-graph';
import { FACTORY_MAP } from './factory-map';
import { cardLive, deepestStep, type HomeMapRow, mergedToday, versionRecorded } from './live';

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

const here = (rows: HomeMapRow[]) =>
  Object.fromEntries(
    [...cardLive(FACTORY_MAP, { map: rows }, new Date()).entries()]
      .filter(([, live]) => live.here.length > 0)
      .map(([id, live]) => [id, live.here.map((l) => l.run)]),
  );

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
    plan: ['e'],
    hold: ['g'],
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
      lap('hold', ['write'], 'factory-holdouts'),
    ]),
  ).toEqual({
    build: ['ask', 'impl'],
    review: ['rerev', 'rev'],
    merge: ['sweep'],
    hold: ['hold'],
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
