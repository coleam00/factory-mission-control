import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type IssueGraphRow, issueGraph, phaseBars } from '../../app/lib/issue-graph';
import { writeIssue, writePullRequest } from '../../function/ingest';
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

  test('closing an issue its merged PR closes fills its phase bar, whatever Phase line the close carries', async () => {
    const screens = async () =>
      phaseBars(issueGraph((await graph()) as unknown as IssueGraphRow[]).issues).find(
        (b) => b.phase === 'Screens',
      );
    expect(await screens()).toEqual({ phase: 'Screens', merged: 1, total: 7 });
    const issue = (state: 'open' | 'closed', body: string | null, updatedAt: string) =>
      ({
        number: 11,
        title: 'The scorecard and comparison',
        state,
        body,
        html_url: 'https://github.com/coleam00/factory-mission-control/issues/11',
        created_at: '2026-09-29T11:17:00.000Z',
        updated_at: updatedAt,
        closed_at: state === 'closed' ? updatedAt : null,
        labels: [],
      }) as unknown as Parameters<typeof writeIssue>[2];
    await db.transaction(async (tx) => {
      await writePullRequest(tx, 'mission-control', {
        number: 211,
        title: 'The scorecard and comparison',
        state: 'closed',
        merged_at: '2026-10-26T10:00:00.000Z',
        head: { sha: 'f00d000000000000000000000000000000000211' },
        html_url: 'https://github.com/coleam00/factory-mission-control/pull/211',
        created_at: '2026-10-26T09:00:00.000Z',
        updated_at: '2026-10-26T10:00:00.000Z',
        closed_at: '2026-10-26T10:00:00.000Z',
        body: 'Closes #11',
      } as unknown as Parameters<typeof writePullRequest>[2]);
      await writeIssue(tx, 'mission-control', issue('closed', null, '2026-10-26T10:00:01.000Z'));
    });
    expect((await states())[11]).toBe('merged');
    expect(await screens()).toEqual({ phase: 'Screens', merged: 2, total: 7 });

    // A later delivery about the closed issue naming another phase leaves it where it closed.
    await db.transaction((tx) =>
      writeIssue(
        tx,
        'mission-control',
        issue('closed', 'Phase: Webhook Function handler', '2026-10-26T11:00:00.000Z'),
      ),
    );
    expect(await screens()).toEqual({ phase: 'Screens', merged: 2, total: 7 });

    // Reopened, it takes its body's phase again.
    await db.transaction((tx) =>
      writeIssue(tx, 'mission-control', issue('open', 'Phase: Polish', '2026-10-26T12:00:00.000Z')),
    );
    expect(await screens()).toEqual({ phase: 'Screens', merged: 1, total: 6 });
  });

  test('another factory sees none of these issues', async () => {
    expect(await db.query(sql, ['other'])).toEqual([]);
  });
});
