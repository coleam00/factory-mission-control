import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { UNSTICK_ACTIONS, UNSTICK_KINDS, type UnstickRow } from '../../app/lib/attention';
import { QUEUE_RUNS, QUEUE_UNSTICK } from '../../scripts/fixture/seed';
import type { Db } from '../../scripts/lib/db';
import { onTheSeed, queries } from './test-seed';

const UNSTICK = queries.find(([n]) => n === 'unstick')?.[1] as string;

type Expected = Pick<UnstickRow, 'kind' | 'number' | 'run_id' | 'waits_on' | 'action'> & {
  since: string;
};

describe('the unstick query on the seed', () => {
  let db: Db;

  beforeAll(async () => {
    db = await onTheSeed();
  }, 60_000);
  afterAll(() => db.close());

  test('finds the blocked and the parked item whose blockers merged, the capacity wait and the stale claim', async () => {
    const rows = await db.query(UNSTICK, ['queue-factory']);
    const u = QUEUE_UNSTICK;
    const found = rows.map((r) => r as unknown as UnstickRow);
    const [factory] = await db.query('SELECT console FROM mc.factories WHERE name = $1', [
      'queue-factory',
    ]);
    for (const r of found) expect(r.console).toBe(String(factory?.console));
    expect(new Set(found.map((r) => r.kind))).toEqual(new Set(UNSTICK_KINDS));
    expect(new Set(found.map((r) => r.action))).toEqual(new Set(UNSTICK_ACTIONS));
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
    ).toEqual<Expected[]>([
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
        since: expect.any(String) as unknown as string,
        action: 'retriage',
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

  test('names the item, what it waits on and why it was parked, so a card can say it in words', async () => {
    const u = QUEUE_UNSTICK;
    const rows = (await db.query(UNSTICK, ['queue-factory'])) as unknown as UnstickRow[];
    const of = (kind: string) => rows.find((r) => r.kind === kind);
    expect(of('parked')).toMatchObject({
      title: `Queue issue ${u.parkedMerged.issue}`,
      blocker_titles: [`Queue issue ${u.parkedMerged.blocker}`],
      reason: u.parkedReason,
      open: true,
    });
    expect(of('blocked')).toMatchObject({
      title: `Queue issue ${u.blockedMerged.issue}`,
      blocker_titles: [`Queue issue ${u.blockedMerged.blocker}`],
      reason: null,
      open: true,
    });
    expect(of('capacity')).toMatchObject({ blocker_titles: null, reason: null, open: false });
    expect(of('claim')).toMatchObject({ blocker_titles: null, reason: null, open: false });
  });

  test('reads a claim or capacity item as open once the mirror holds its issue open', async () => {
    const number = QUEUE_UNSTICK.claimed.issue;
    const at = '2026-10-24T09:08:00.000Z';
    await db.query(
      `INSERT INTO mc.issues (factory, number, title, state, url, created_at, updated_at)
       VALUES ('queue-factory', $1, 'open item', 'open', $2, $3, $3)`,
      [number, `https://github.com/example/queue-factory/issues/${number}`, at],
    );
    try {
      const rows = (await db.query(UNSTICK, ['queue-factory'])) as unknown as UnstickRow[];
      const of = (kind: string) => rows.find((r) => r.kind === kind);
      expect(of('capacity')).toMatchObject({ number, open: true });
      expect(of('claim')).toMatchObject({ number, open: true });
    } finally {
      await db.query(`DELETE FROM mc.issues WHERE factory = 'queue-factory' AND number = $1`, [
        number,
      ]);
    }
  });

  test('flags nothing for an item whose blocker is still open, and runs on a factory without any', async () => {
    const numbers = (await db.query(UNSTICK, ['queue-factory'])).map((r) => r.number);
    expect(numbers).not.toContain(QUEUE_UNSTICK.blockedOpen.issue);
    expect(numbers).not.toContain(QUEUE_UNSTICK.parkedOpen.issue);
    expect(numbers).not.toContain(413);
    expect(await db.query(UNSTICK, ['mission-control'])).toEqual([]);
  });

  test('flags an item only when every blocker is gone, and a blocker that is not mirrored is not gone', async () => {
    const at = '2026-10-24T09:08:00.000Z';
    const url = (kind: string, n: number) =>
      `https://github.com/example/queue-factory/${kind}/${n}`;
    const pr = (n: number, merged: boolean) =>
      db.query(
        `INSERT INTO mc.pull_requests (factory, number, title, state, merged_at, head_sha, url, created_at, updated_at, closed_at)
         VALUES ('queue-factory', $1, 'pr', $2, $3, $4, $5, $6, $6, $3)`,
        [
          n,
          merged ? 'closed' : 'open',
          merged ? at : null,
          `${'f'.repeat(39)}${n % 10}`,
          url('pull', n),
          at,
        ],
      );
    const item = async (n: number, blockers: number[], kind: 'dependency' | 'ruling') => {
      await db.query(
        `INSERT INTO mc.issues (factory, number, title, state, url, created_at, updated_at)
         VALUES ('queue-factory', $1, 'item', 'open', $2, $3, $3)`,
        [n, url('issues', n), at],
      );
      await db.query(
        `INSERT INTO mc.work_item_states (project_key, number, revision, build_status, build_at, triage_at, stage)
         SELECT codebase, $1, 1, $2, $3, $4, $5 FROM mc.factories WHERE name = 'queue-factory'`,
        [
          n,
          kind === 'ruling' ? 'parked' : null,
          kind === 'ruling' ? '2026-10-24T09:06:00.000Z' : null,
          '2026-10-24T09:01:00.000Z',
          kind === 'dependency' ? 'blocked' : null,
        ],
      );
      for (const b of blockers) {
        await db.query(
          kind === 'dependency'
            ? "INSERT INTO mc.issue_dependencies (factory, issue_number, depends_on) VALUES ('queue-factory', $1, $2)"
            : "INSERT INTO mc.work_item_blockers (project_key, number, blocker) SELECT codebase, $1, $2 FROM mc.factories WHERE name = 'queue-factory'",
          [n, b],
        );
      }
    };
    await pr(471, true);
    await pr(472, false);
    await pr(474, true);
    await pr(477, true);
    await pr(478, false);
    await pr(480, true);
    await pr(481, true);
    await item(470, [471, 472], 'dependency');
    await item(473, [474, 475], 'dependency');
    await item(476, [477, 478], 'ruling');
    await item(479, [480, 481], 'dependency');
    const rows = await db.query(UNSTICK, ['queue-factory']);
    const added = rows.filter((r) => Number(r.number) >= 470 && Number(r.number) <= 481);
    expect(added.map((r) => [r.number, r.waits_on])).toEqual([[479, '#480, #481']]);
  });
});
