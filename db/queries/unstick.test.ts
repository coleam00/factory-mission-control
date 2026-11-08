import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { QUEUE_RUNS, QUEUE_UNSTICK } from '../../scripts/fixture/seed';
import type { Db } from '../../scripts/lib/db';
import { onTheSeed, queries } from './test-seed';

const UNSTICK = queries.find(([n]) => n === 'unstick')?.[1] as string;

describe('the unstick query on the seed', () => {
  let db: Db;

  beforeAll(async () => {
    db = await onTheSeed();
  }, 60_000);
  afterAll(() => db.close());

  test('finds the blocked and the parked item whose blockers merged, the capacity wait and the stale claim', async () => {
    const rows = await db.query(UNSTICK, ['queue-factory']);
    const u = QUEUE_UNSTICK;
    expect(
      rows
        .map((r) => ({
          kind: r.kind,
          number: r.number,
          run_id: r.run_id,
          waits_on: r.waits_on,
          since: new Date(String(r.since)).toISOString(),
          action: r.action,
        }))
        .sort((a, b) => String(a.kind).localeCompare(String(b.kind))),
    ).toEqual([
      {
        kind: 'blocked',
        number: u.blockedMerged.issue,
        run_id: null,
        waits_on: `#${u.blockedMerged.blocker}`,
        since: u.mergedAt,
        action: 'retriage',
      },
      {
        kind: 'capacity',
        number: 458,
        run_id: QUEUE_RUNS.capacity,
        waits_on: 'a free slot',
        since: u.capacitySince,
        action: 'resume',
      },
      {
        kind: 'claim',
        number: u.claimed.issue,
        run_id: QUEUE_RUNS.built,
        waits_on: 'a claim held by a finished run',
        since: expect.any(String),
        action: 'release_claim',
      },
      {
        kind: 'parked',
        number: u.parkedMerged.issue,
        run_id: null,
        waits_on: `#${u.parkedMerged.blocker}`,
        since: u.mergedAt,
        action: 'retriage',
      },
    ]);
  });

  test('flags nothing for an item whose blocker is still open, and runs on a factory without any', async () => {
    const numbers = (await db.query(UNSTICK, ['queue-factory'])).map((r) => r.number);
    expect(numbers).not.toContain(QUEUE_UNSTICK.blockedOpen.issue);
    expect(numbers).not.toContain(QUEUE_UNSTICK.parkedOpen.issue);
    expect(numbers).not.toContain(413);
    expect(await db.query(UNSTICK, ['mission-control'])).toEqual([]);
  });
});
