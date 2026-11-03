import { expect, test } from 'bun:test';
import type { RecentLapRow } from '../lib/laps';
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

const recent = (
  run: string,
  completed: Date | null,
  outcome: RecentLapRow['outcome'],
): RecentLapRow => ({
  run_id: run,
  status: 'completed',
  started_at: null,
  completed_at: completed,
  issue_number: 3,
  outcome,
  cost_usd: null,
});

test("merged counts the laps that merged on the browser's local day, newest first", () => {
  const now = new Date(2026, 10, 3, 15, 0);
  expect(
    mergedToday(
      [
        recent('morning', new Date(2026, 10, 3, 0, 5), 'merged'),
        recent('noon', new Date(2026, 10, 3, 12, 0), 'merged'),
        recent('yesterday', new Date(2026, 10, 2, 23, 59), 'merged'),
        recent('refused', new Date(2026, 10, 3, 9, 0), 'gate-refused'),
        recent('unfinished', null, 'merged'),
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
  expect(live.get('out')?.merged).toBeUndefined();
  expect(live.get('review')).toEqual({ here: [] });
});

test('the current version is always recorded; a pinned one only when the query names it', () => {
  const version: HomeMapRow = { ...lap('x', null), kind: 'version', run_id: null, workflow: null };
  expect(versionRecorded([], null)).toBe(true);
  expect(versionRecorded([], 'abc')).toBe(false);
  expect(versionRecorded([version], 'abc')).toBe(true);
});
