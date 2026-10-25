import { expect, test } from 'bun:test';
import { compareLinks, NOT_RECORDED, stripEntries, type VersionStripRow } from './version-strip';

const version = (
  digest: string,
  firstRun: string,
  pin: string | null,
  over = {},
): VersionStripRow => ({
  digest,
  first_run_at: new Date(firstRun),
  pin_sha: pin,
  reason: pin === null ? null : `reason ${pin}`,
  hypothesis: 'faster',
  measure: 'hours',
  committed_at: null,
  ...over,
});

test('entries run oldest first, a pin not yet run last, and a missing trailer is not recorded', () => {
  const entries = stripEntries([
    {
      digest: null,
      first_run_at: null,
      pin_sha: 'p4',
      reason: 'next',
      hypothesis: null,
      measure: null,
      committed_at: new Date('2026-10-25T12:00:00Z'),
    },
    version('sha256:c3', '2026-10-20T23:30:00Z', 'p3', { hypothesis: null, measure: null }),
    version('sha256:a1', '2026-10-01T09:00:00Z', 'p1'),
    version('sha256:b2', '2026-10-10T09:00:00Z', null, { measure: ' ' }),
  ]);
  expect(entries.map((e) => [e.digest, e.pin, e.date])).toEqual([
    ['sha256:a1', 'p1', '2026-10-01'],
    ['sha256:b2', null, '2026-10-10'],
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
