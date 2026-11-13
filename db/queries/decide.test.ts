import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { attentionItems, type DecideRow, recommendationReason } from '../../app/lib/attention';
import { decideCards } from '../../app/lib/attention-page';
import type { Db } from '../../scripts/lib/db';
import { onTheSeed, queries } from './test-seed';

const DECIDE = queries.find(([n]) => n === 'decide')?.[1] as string;

describe('the decide query on the seed', () => {
  let db: Db;

  beforeAll(async () => {
    db = await onTheSeed();
  }, 60_000);
  afterAll(() => db.close());

  const decide = async (factory: string) =>
    attentionItems((await db.query(DECIDE, [factory])) as unknown as DecideRow[]);

  test('each open question has its options with descriptions, recommendation, confidence, item and occurrence', async () => {
    const items = await decide('mission-control');
    expect(
      items.map((i) => [
        i.occurrence_id,
        i.item_number,
        i.recommended,
        i.confidence,
        i.recommendation_why,
        i.options.map((o) => [o.id, o.label, o.description]),
      ]),
    ).toEqual([
      [
        'seed-build-ask',
        15,
        'split',
        'high',
        null,
        [
          ['split', 'Split the issue in two', 'Two issues, one per screen, each reviewed alone.'],
          ['build', 'Build it as written', 'One change for both screens, reviewed together.'],
          ['other', 'Something else', 'Say what to do instead.'],
        ],
      ],
      [
        'seed-merge-ask',
        16,
        'merge',
        'medium',
        'Nothing in it waits on another change.',
        [
          ['merge', 'Merge it now', 'Merge the pull request into the default branch.'],
          ['hold', 'Hold it for the next lap', 'Leave it open and decide again next lap.'],
          ['other', 'Something else', 'Say what to do instead.'],
        ],
      ],
    ]);
  });

  test('the merge question, structured, renders its note from the fields and answers the option id; the build question from its message', async () => {
    const rows = (await db.query(DECIDE, ['mission-control'])) as unknown as DecideRow[];
    const cards = decideCards(rows, 'mission-control');
    const merge = cards.find((c) => c.title.startsWith('#16:'));
    expect(merge?.note.lead).toContain('#16 “The owner queue” waits at');
    expect(merge?.note.lead).toEndWith('Recommends Merge it now.');
    expect(merge?.note.rest).toBe('Nothing in it waits on another change.');
    expect(merge?.tiles[0]?.id).toBe('merge');
    expect(merge?.tiles.find((t) => t.id === 'merge')?.act?.request).toMatchObject({
      option: 'merge',
    });
    const build = cards.find((c) => c.title.startsWith('#15:'));
    expect(build?.note.rest).toBe(
      recommendationReason(rows.find((r) => r.item_number === 15)?.message ?? ''),
    );
    expect(build?.note.rest).not.toBe('');
  });

  test('a question without a recommendation has none, and an answered run is not a question', async () => {
    const items = await decide('queue-factory');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      occurrence_id: '5eedaaaa-0000-4000-8000-000000000001',
      recommended: null,
      confidence: null,
      options: [],
    });
  });

  test('names the item a wait is about from the mirrored issue, and has none for a wait about no item', async () => {
    const seeded = (await db.query(DECIDE, ['mission-control'])) as unknown as DecideRow[];
    expect(seeded.map((r) => [r.item_number, r.item_title])).toEqual([
      [15, 'Lanes and recent laps'],
      [16, 'The owner queue'],
    ]);
    const queue = (await db.query(DECIDE, ['queue-factory'])) as unknown as DecideRow[];
    expect(queue.map((r) => [r.item_number, r.item_title])).toEqual([[null, null]]);
  });
});
