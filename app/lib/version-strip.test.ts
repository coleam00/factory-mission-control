import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { seededDb } from '../../scripts/fixture/seed';
import { REPO_ROOT } from '../../scripts/lib/cli';
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
    version('sha256:c3', '2026-10-20T23:30:00Z', 'p3', {
      hypothesis: null,
      measure: null,
      committed_at: new Date('2026-10-19T18:00:00Z'),
    }),
    version('sha256:a1', '2026-10-01T09:00:00Z', 'p1', {
      committed_at: new Date('2026-09-30T18:00:00Z'),
    }),
    version('sha256:b2', '2026-10-10T09:00:00Z', null, { measure: ' ' }),
  ]);
  expect(entries.map((e) => [e.digest, e.pin, e.date])).toEqual([
    ['sha256:a1', 'p1', '2026-09-30'],
    ['sha256:b2', null, NOT_RECORDED],
    ['sha256:c3', 'p3', '2026-10-19'],
    [null, 'p4', '2026-10-25'],
  ]);
  expect(entries[1]).toMatchObject({ reason: NOT_RECORDED, measure: NOT_RECORDED });
  expect(entries[2]).toMatchObject({ hypothesis: NOT_RECORDED, measure: NOT_RECORDED });
});

test('a late pin changes the label and date together, keeping first-run order', () => {
  const original = version('sha256:a1', '2026-10-01T09:00:00Z', 'p1', {
    committed_at: new Date('2026-09-29T18:00:00Z'),
  });
  const unpinned = version('sha256:b2', '2026-10-02T09:00:00Z', null);
  expect(stripEntries([unpinned, original])[0]).toMatchObject({ pin: 'p1', date: '2026-09-29' });
  expect(
    stripEntries([
      unpinned,
      { ...original, pin_sha: 'late', committed_at: new Date('2026-10-01T01:00:00+02:00') },
    ]).map(({ digest, pin, date }) => ({ digest, pin, date })),
  ).toEqual([
    { digest: original.digest, pin: 'late', date: '2026-09-30' },
    { digest: unpinned.digest, pin: null, date: NOT_RECORDED },
  ]);
  expect(stripEntries([version('sha256:c3', '2026-10-03T09:00:00Z', 'missing-date')])[0].date).toBe(
    NOT_RECORDED,
  );
});

test('the three seed versions display their labelled pins commit dates from fixtures/seed.sql', async () => {
  const db = await seededDb(REPO_ROOT, readFileSync(join(REPO_ROOT, 'fixtures/seed.sql'), 'utf8'));
  try {
    const sql = readFileSync(join(REPO_ROOT, 'db/queries/version-strip.sql'), 'utf8');
    const rows = (await db.query(sql, ['mission-control'])) as unknown as VersionStripRow[];
    const pins = await db.query('SELECT sha, committed_at FROM mc.pins ORDER BY committed_at');
    const entries = stripEntries(rows);
    expect(entries).toHaveLength(3);
    expect(entries.map(({ pin, date }) => ({ pin, date }))).toEqual(
      pins.map(({ sha, committed_at }) => ({
        pin: String(sha),
        date: (committed_at as Date).toISOString().slice(0, 10),
      })),
    );
    expect(entries.map(({ date }) => date)).toEqual(['2026-09-30', '2026-10-09', '2026-10-19']);
  } finally {
    await db.close();
  }
}, 60_000);

test('compare links carry each digest URL-encoded, so it reads back unchanged', () => {
  const a = `sha256:${'a1'.repeat(32)}`;
  const b = 'sha256:b2&x=/?#';
  const links = compareLinks('mission-control', a, b);
  const scorecard = new URL(links.scorecard, 'http://localhost');
  expect(scorecard.pathname).toBe('/f/mission-control/scorecard');
  expect([scorecard.searchParams.get('a'), scorecard.searchParams.get('b')]).toEqual([a, b]);
  const diff = new URL(links.diff, 'http://localhost');
  expect(diff.pathname).toBe('/f/mission-control/diff');
  expect([diff.searchParams.get('a'), diff.searchParams.get('b')]).toEqual([a, b]);
});
