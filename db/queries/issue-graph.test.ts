import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { writeRow } from '../../scripts/fixture/write';
import type { Db } from '../../scripts/lib/db';
import { onTheSeed, queries } from './test-seed';

describe('issue-graph on the seed', () => {
  let db: Db;
  const sql = queries.find(([name]) => name === 'issue-graph')?.[1] as string;
  const graph = () => db.query(sql, ['mission-control']);
  const states = async () =>
    Object.fromEntries(
      (await graph()).filter((r) => r.kind === 'issue').map((r) => [r.number, r.state]),
    );

  beforeAll(async () => {
    db = await onTheSeed();
  }, 60_000);

  afterAll(() => db.close());

  test('is every seeded issue in its one state, and every Depends on line as an edge', async () => {
    expect(await states()).toEqual({
      1: 'merged',
      2: 'merged',
      3: 'merged',
      4: 'closed',
      5: 'merged',
      6: 'merged',
      7: 'merged',
      8: 'merged',
      9: 'pr-open',
      10: 'merged',
      11: 'claimed',
      12: 'pr-open',
      13: 'needs-owner',
      14: 'waiting',
      15: 'waiting',
      16: 'claimed',
      17: 'waiting',
      18: 'waiting',
    });
    const edges = (await graph())
      .filter((r) => r.kind === 'edge')
      .map((r) => [r.number, r.depends_on])
      .sort(([a, b], [c, d]) => Number(a) - Number(c) || Number(b) - Number(d));
    const seeded = await db.query(
      'SELECT issue_number, depends_on FROM mc.issue_dependencies WHERE factory = $1 ORDER BY 1, 2',
      ['mission-control'],
    );
    expect(edges).toEqual(seeded.map((r) => [r.issue_number, r.depends_on]));
  });

  test('a needs-owner label from fixture:write turns a waiting issue needs-owner', async () => {
    await db.transaction(async (tx) => {
      await writeRow(tx, 'label', new Date('2026-10-25T12:00:00Z'));
    });
    expect((await states())[18]).toBe('needs-owner');
  });

  test('another factory sees none of these issues', async () => {
    expect(await db.query(sql, ['other'])).toEqual([]);
  });
});
