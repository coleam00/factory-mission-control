import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type Issue, writeIssue, writeLabeledAt } from '../../function/ingest';
import { writeRow } from '../../scripts/fixture/write';
import type { Db } from '../../scripts/lib/db';
import { onTheSeed, queries } from './test-seed';

const sql = queries.find(([name]) => name === 'owner-queue')?.[1] as string;

test('owner-queue is a single SELECT with no volatile function', () => {
  expect(sql).toMatch(/^SELECT\b/);
  expect(sql).not.toContain(';');
  for (const banned of ['now(', 'random(', 'clock_timestamp(', 'current_timestamp']) {
    expect(sql.toLowerCase()).not.toContain(banned);
  }
});

describe('owner-queue on the seed', () => {
  let db: Db;
  const queue = () => db.query(sql, ['mission-control']);
  const ids = async () =>
    (await queue())
      .map((r) =>
        r.kind === 'issue' ? `#${r.issue_number}` : `#${r.issue_number} Q${r.question_number}`,
      )
      .sort();

  beforeAll(async () => {
    db = await onTheSeed();
  }, 60_000);

  afterAll(() => db.close());

  test("is the seed's open needs-owner issues and open owner questions", async () => {
    expect(await ids()).toEqual(['#13', '#17 Q2', '#17 Q3']);
  });

  test('a question carries its options, recommendation, default, default date and its issue URL', async () => {
    const q2 = (await queue()).find((r) => r.kind === 'question' && r.question_number === 2);
    expect(q2).toMatchObject({
      title: 'Should the lanes panel show finished laps for an hour?',
      url: 'https://github.com/coleam00/factory-mission-control/issues/17',
      recommendation: 'A, so a merge that just happened is still visible.',
      default_option: 'A',
      default_at: new Date('2026-10-27T14:00:00Z'),
      waiting_since: new Date('2026-10-23T09:00:00Z'),
    });
    expect(JSON.parse(String(q2?.options))).toEqual([
      { key: 'A', text: 'yes, faded' },
      { key: 'B', text: 'no, only running laps' },
    ]);
  });

  const issueRow = async (number: number) =>
    (await queue()).find((r) => r.kind === 'issue' && r.issue_number === number);

  test('an issue carries its title, URL and when it was labelled, before its later comment', async () => {
    expect(await issueRow(13)).toMatchObject({
      title: 'The architecture diff',
      url: 'https://github.com/coleam00/factory-mission-control/issues/13',
      waiting_since: new Date('2026-10-10T20:30:00Z'),
      approximate: false,
    });
  });

  test('a needs-owner label from fixture:write adds its issue', async () => {
    await db.transaction(async (tx) => {
      await writeRow(tx, 'label', new Date('2026-10-25T12:00:00Z'));
    });
    expect(await ids()).toEqual(['#13', '#17 Q2', '#17 Q3', '#18']);
    expect(await issueRow(18)).toMatchObject({
      waiting_since: new Date('2026-10-25T12:00:00Z'),
      approximate: false,
    });
  });

  test('a closed issue or question leaves the queue', async () => {
    await db.query(`UPDATE mc.issues SET state = 'closed' WHERE factory = $1 AND number = 18`, [
      'mission-control',
    ]);
    await db.query(
      `UPDATE mc.owner_questions SET closed_at = '2026-10-26T00:00:00Z'
       WHERE factory = $1 AND issue_number = 17 AND question_number = 3`,
      ['mission-control'],
    );
    expect(await ids()).toEqual(['#13', '#17 Q2']);
  });

  /** Issue `number` as GitHub sends it at `updatedAt`, carrying `labels`. */
  const delivered = (number: number, updatedAt: string, labels: string[]): Issue => ({
    number,
    title: `Issue ${number}`,
    state: 'open',
    body: null,
    html_url: `https://github.com/coleam00/factory-mission-control/issues/${number}`,
    created_at: '2026-09-29T11:00:00Z',
    updated_at: updatedAt,
    closed_at: null,
    labels: labels.map((name) => ({ name })),
  });
  const deliver = (issue: Issue, labelled?: string) =>
    db.transaction(async (tx) => {
      await writeIssue(tx, 'mission-control', issue);
      if (labelled) {
        await writeLabeledAt(tx, 'mission-control', issue.number, labelled, issue.updated_at);
      }
    });

  test('a comment, edit or other label after labelling leaves the wait unchanged', async () => {
    await deliver(delivered(13, '2026-10-26T08:00:00Z', ['needs-owner']));
    await deliver(
      delivered(13, '2026-10-26T08:05:00Z', ['needs-owner', 'enhancement']),
      'enhancement',
    );
    expect(await issueRow(13)).toMatchObject({
      waiting_since: new Date('2026-10-10T20:30:00Z'),
      approximate: false,
    });
  });

  test('removing the label and adding it again restarts the wait', async () => {
    await deliver(delivered(13, '2026-10-26T09:00:00Z', []));
    expect(await issueRow(13)).toBeUndefined();
    await deliver(delivered(13, '2026-10-26T09:30:00Z', ['needs-owner']), 'needs-owner');
    await deliver(delivered(13, '2026-10-26T10:00:00Z', ['needs-owner']));
    expect(await issueRow(13)).toMatchObject({
      waiting_since: new Date('2026-10-26T09:30:00Z'),
      approximate: false,
    });
  });

  test('an issue whose label time was never recorded waits since its last update, approximately', async () => {
    await deliver(delivered(14, '2026-10-26T11:00:00Z', ['needs-owner']));
    expect(await issueRow(14)).toMatchObject({
      waiting_since: new Date('2026-10-26T11:00:00Z'),
      approximate: true,
    });
  });

  test('another factory sees none of these items', async () => {
    expect(await db.query(sql, ['another-factory'])).toEqual([]);
  });
});
