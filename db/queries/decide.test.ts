import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { attentionItems, type DecideRow } from '../../app/lib/attention';
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
        i.options.map((o) => [o.id, o.label, o.description]),
      ]),
    ).toEqual([
      [
        'seed-build-ask',
        15,
        'split',
        'high',
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
        [
          ['merge', 'Merge it now', 'Merge the pull request into the default branch.'],
          ['hold', 'Hold it for the next lap', 'Leave it open and decide again next lap.'],
          ['other', 'Something else', 'Say what to do instead.'],
        ],
      ],
    ]);
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
});
