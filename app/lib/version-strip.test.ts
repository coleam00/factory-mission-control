import { expect, test } from 'bun:test';
import {
  compareLinks,
  NOT_RECORDED,
  stripEntries,
  utcDay,
  type VersionStripRow,
} from './version-strip';

const row = (over: Partial<VersionStripRow>): VersionStripRow => ({
  digest: null,
  first_run_at: null,
  pin_sha: null,
  reason: null,
  hypothesis: null,
  measure: null,
  committed_at: null,
  ...over,
});

test('utcDay reads every form a timestamp reaches the browser in', () => {
  expect(utcDay('2026-10-01T23:30:00.000Z')).toBe('2026-10-01');
  expect(utcDay('2026-10-01T23:30:00+00:00')).toBe('2026-10-01');
  expect(utcDay('2026-10-01 23:30:00+00')).toBe('2026-10-01');
  expect(utcDay('2026-10-02 01:30:00+02')).toBe('2026-10-01');
});

test('entries run oldest first, a pin not yet run last, and a missing trailer is not recorded', () => {
  const entries = stripEntries([
    row({ committed_at: '2026-10-25 12:00:00+00', pin_sha: 'p4', reason: 'next' }),
    row({ digest: 'sha256:c3', first_run_at: '2026-10-20T09:00:00Z', pin_sha: 'p3', reason: 'V3' }),
    row({
      digest: 'sha256:a1',
      first_run_at: '2026-10-01T09:00:00Z',
      pin_sha: 'p1',
      reason: 'V1',
      hypothesis: 'faster',
      measure: 'hours',
    }),
    row({ digest: 'sha256:b2', first_run_at: '2026-10-10T09:00:00Z', pin_sha: 'p2', measure: ' ' }),
  ]);
  expect(entries.map((e) => [e.digest, e.pin, e.date])).toEqual([
    ['sha256:a1', 'p1', '2026-10-01'],
    ['sha256:b2', 'p2', '2026-10-10'],
    ['sha256:c3', 'p3', '2026-10-20'],
    [null, 'p4', '2026-10-25'],
  ]);
  expect(entries[1]).toMatchObject({ reason: NOT_RECORDED, measure: NOT_RECORDED });
  expect(entries[2]).toMatchObject({ hypothesis: NOT_RECORDED, measure: NOT_RECORDED });
});

test('compare links carry each digest URL-encoded, so it reads back unchanged', () => {
  const a = `sha256:${'a1'.repeat(32)}`;
  const b = 'sha256:b2&x=/?#';
  const links = compareLinks('mission-control', a, b);
  const scorecard = new URL(links.scorecard, 'http://localhost');
  expect(scorecard.pathname).toBe('/f/mission-control/scorecard');
  expect([scorecard.searchParams.get('a'), scorecard.searchParams.get('b')]).toEqual([a, b]);
  const diff = new URL(links.diff, 'http://localhost');
  expect(diff.pathname).toBe('/diff');
  expect([diff.searchParams.get('a'), diff.searchParams.get('b')]).toEqual([a, b]);
});
