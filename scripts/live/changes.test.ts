import { expect, test } from 'bun:test';
import { compareTimeline, type OldScreens, type ShownChange } from './changes';

const old: OldScreens = {
  versions: ['sha256:v1', 'sha256:v2', 'pin:p3'],
  decisions: [{ date: '2026-10-11', title: 'Keep it' }],
  verdicts: [
    { key: 'p1', unmatched: false, verdict: 'helped' },
    { key: 'dead', unmatched: true, verdict: 'hurt' },
  ],
};

const row = (over: Partial<ShownChange>): ShownChange => ({
  change: 'version',
  digest: null,
  pin: null,
  verdict: null,
  date: null,
  title: null,
  prefix: null,
  parent: null,
  ...over,
});

const good: ShownChange[] = [
  row({ pin: 'p3' }),
  row({ digest: 'sha256:v2', pin: 'p2' }),
  row({ change: 'decision', date: '2026-10-11', title: 'Keep it', parent: 'sha256:v2' }),
  row({ change: 'verdict', prefix: 'dead', verdict: 'hurt' }),
  row({ digest: 'sha256:v1', pin: 'p1', verdict: 'helped' }),
];

test('a timeline with every version, decision and verdict, newest first, passes', () => {
  expect(compareTimeline(old, good)).toEqual([]);
});

test('a missing decision, a missing verdict and a reordered version each fail by name', () => {
  expect(
    compareTimeline(
      old,
      good.filter((c) => c.change !== 'decision'),
    ),
  ).toEqual(['decision 2026-10-11 Keep it is not on the timeline']);
  expect(
    compareTimeline(
      old,
      good.filter((c) => c.change !== 'verdict'),
    ),
  ).toEqual(['verdict hurt on dead is not on the timeline']);
  const swapped = [good[1], good[0], ...good.slice(2)];
  expect(compareTimeline(old, swapped)[0]).toStartWith('versions:');
});
