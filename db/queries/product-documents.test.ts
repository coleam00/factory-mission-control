import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { ProductDocumentRow } from '../../app/map/live';
import type { Db } from '../../scripts/lib/db';
import { onTheSeed, queries } from './test-seed';

const sql = queries.find(([name]) => name === 'product-documents')?.[1] as string;

let db: Db;
beforeAll(async () => {
  db = await onTheSeed();
}, 60_000);
afterAll(() => db.close());

const documents = (factory = 'queue-factory') =>
  db.query(sql, [factory]) as unknown as Promise<ProductDocumentRow[]>;

const issue = (number: number, state = 'open') =>
  db.query(
    `INSERT INTO mc.issues (factory, number, title, state, url, created_at, updated_at)
     VALUES ('queue-factory', $1, $2, $3, 'u', now(), now())`,
    [number, `Document ${number}`, state],
  );
const prd = (number: number) =>
  db.query(
    `INSERT INTO mc.issue_labels (factory, issue_number, label) VALUES ('queue-factory', $1, 'archon-prd')`,
    [number],
  );
const publish = async (run: string, item: number, issues: number[], completed: string) => {
  await db.query(
    `INSERT INTO mc.laps (run_id, factory, workflow_name, status) VALUES ($1, 'queue-factory', 'archon-split', 'completed')`,
    [run],
  );
  await db.query(
    `INSERT INTO mc.lap_steps (run_id, step_id, status, completed_at, output)
     VALUES ($1, 'publish', 'completed', $2, $3)`,
    [
      run,
      completed,
      JSON.stringify({
        path: 'slice',
        item,
        issues: issues.map((number) => ({ key: `k${number}`, number })),
        adopted: [],
      }),
    ],
  );
};

test('the seeded document counts the issues its split recorded and adopted, merged over total', async () => {
  expect(await documents()).toEqual([
    {
      number: 410,
      title: 'Queue product document',
      url: 'https://github.com/coleam00/queue-factory/issues/410',
      total_count: 4,
      merged_count: 2,
    },
  ]);
});

test('the newest split record wins, a closed document is not listed, and one with no record is 0 of 0', async () => {
  await publish(
    '5eed0099-0000-4000-8000-000000000001',
    410,
    [411, 412, 413, 414, 415],
    '2026-10-25T00:00:00Z',
  );
  await issue(420);
  await prd(420);
  await issue(430, 'closed');
  await prd(430);
  expect(await documents()).toMatchObject([
    { number: 410, total_count: 5, merged_count: 2 },
    { number: 420, total_count: 0, merged_count: 0 },
  ]);
});

test('another factory lists nothing', async () => {
  expect(await documents('mission-control')).toEqual([]);
});
