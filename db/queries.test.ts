import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from '../scripts/lib/db';
import { LIVE_QUERY_NAME, parameterCount } from '../server/live';
import { migratedDb, paramsFor, queries } from './queries/test-seed';

const dir = join(import.meta.dir, 'queries');

/** Functions whose value changes between evaluations; Realtime refuses them (REALTIME.md). */
const VOLATILE =
  /\b(now|random|clock_timestamp|statement_timestamp|transaction_timestamp|timeofday|gen_random_uuid|nextval|current_timestamp|current_date|current_time|localtime|localtimestamp)\b/i;

test('every file in db/queries/ is a live query named for its panel', () => {
  const sqlFiles = readdirSync(dir).filter((f) => f.endsWith('.sql'));
  expect(sqlFiles.length).toBeGreaterThan(0);
  for (const file of sqlFiles) expect(file.slice(0, -4)).toMatch(LIVE_QUERY_NAME);
});

describe.each(queries)('db/queries/%s.sql', (name, sql) => {
  test('is one read-only SELECT', () => {
    expect(sql).not.toContain(';');
    expect(sql).toMatch(/^(SELECT|WITH)\b/i);
    expect(sql).not.toMatch(/\b(insert|update|delete|merge|truncate|for\s+update|for\s+share)\b/i);
  });

  test('uses no volatile function', () => {
    expect(sql).not.toMatch(VOLATILE);
  });

  test("reads the dashboard's own tables, never Archon's", () => {
    expect(sql).not.toMatch(/remote_agent_|provider_event/i);
  });

  test("is keyed by one factory, $1, a step panel's by the step's workflow, path and version, a lap's by its run id", () => {
    expect(sql).toMatch(/\$1\b/);
    expect(parameterCount(sql)).toBe(paramsFor(name, '').length);
  });
});

describe('against the migrated schema', () => {
  let db: Db;

  beforeAll(async () => {
    db = await migratedDb();
  });

  afterAll(() => db.close());

  test.each(queries)('%s runs with a factory name as $1', async (name, sql) => {
    await db.query(sql, paramsFor(name, 'mission-control'));
  });
});
