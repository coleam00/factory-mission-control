import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { joinParts } from '../app/lib/step-detail';
import type { Db } from '../scripts/lib/db';
import { runMigrations } from '../scripts/migrate';
import { LIVE_QUERY_NAME, loadLiveQueries } from '../server/live';
import { archonDb, migrationFiles } from './test-db';

const dir = join(import.meta.dir, 'queries');
const queries = [...loadLiveQueries(dir)];

/** Functions whose value changes between evaluations; Realtime refuses them (REALTIME.md). */
const VOLATILE =
  /\b(now|random|clock_timestamp|statement_timestamp|transaction_timestamp|timeofday|gen_random_uuid|nextval|current_timestamp|current_date|current_time|localtime|localtimestamp)\b/i;

test('every file in db/queries/ is a live query named for its panel', () => {
  const sqlFiles = readdirSync(dir).filter((f) => f.endsWith('.sql'));
  expect(sqlFiles.length).toBeGreaterThan(0);
  for (const file of sqlFiles) expect(file.slice(0, -4)).toMatch(LIVE_QUERY_NAME);
});

describe.each(queries)('db/queries/%s.sql', (_name, sql) => {
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

  test('is keyed by one factory, $1, and takes no other parameter', () => {
    expect(sql).toMatch(/\$1\b/);
    expect(sql).not.toMatch(/\$([2-9]|\d{2,})/);
  });
});

describe('against the migrated schema', () => {
  let db: Db;

  beforeAll(async () => {
    db = await archonDb();
    await runMigrations({ files: migrationFiles, db });
  });

  afterAll(() => db.close());

  test.each(queries)('%s runs with a factory name as $1', async (_name, sql) => {
    await db.query(sql, ['mission-control']);
  });

  test('status-strip counts one factory’s running laps and nothing else', async () => {
    await db.query(`INSERT INTO mc.laps (run_id, factory, workflow_name, status) VALUES
      ('00000000-0000-0000-0000-0000000000a1', 'mission-control', 'archon-loop', 'running'),
      ('00000000-0000-0000-0000-0000000000a2', 'mission-control', 'archon-loop', 'running'),
      ('00000000-0000-0000-0000-0000000000a3', 'mission-control', 'archon-loop', 'completed'),
      ('00000000-0000-0000-0000-0000000000a5', 'mission-control', 'archon-manager', 'running'),
      ('00000000-0000-0000-0000-0000000000a4', 'other', 'archon-loop', 'running')`);
    const sql = queries.find(([name]) => name === 'status-strip')?.[1] as string;
    expect(await db.query(sql, ['mission-control'])).toEqual([{ running: 2 }]);
    expect(await db.query(sql, ['other'])).toEqual([{ running: 1 }]);
  });

  test('step queries read the newest pin with architecture rows, for a factory the dashboard shows', async () => {
    const sql = (name: string) => queries.find(([n]) => n === name)?.[1] as string;
    // A long multi-byte prompt: each part must stay under the 16 KiB Realtime answers (REALTIME.md).
    const prompt = `${'é'.repeat(4500)}
${'x'.repeat(5000)}`;
    await db.query(`INSERT INTO mc.factories (name, repository, codebase, console)
      VALUES ('mission-control', 'o/r', 'o/r', 'http://localhost:3090')`);
    await db.query(`INSERT INTO mc.pins (sha, archon_sha, reason, committed_at) VALUES
      ('p1', 'a1', 'one', '2026-01-01T00:00:00Z'),
      ('p2', 'a2', 'two', '2026-02-01T00:00:00Z'),
      ('p3', 'a3', 'three, not parsed yet', '2026-03-01T00:00:00Z')`);
    await db.query(`INSERT INTO mc.arch_versions (archon_sha, factory_sha, parsed_at) VALUES
      ('a1', 'f', '2026-01-02T00:00:00Z'), ('a2', 'f', '2026-02-02T00:00:00Z')`);
    for (const [sha, deps] of [
      ['a1', '{subject,briefs}'],
      ['a2', '{subject}'],
    ]) {
      await db.query(
        `INSERT INTO mc.arch_steps (archon_sha, factory_sha, workflow, path, position, step_id, kind,
           depends_on, command_file, defined_in, file)
         VALUES ($1, 'f', 'archon-loop', 'check-app', 0, 'check-app', 'command', $2,
           'loop/commands/loop-check-app.md', 'archon-loop', 'loop/archon-loop.yaml')`,
        [sha, deps],
      );
      await db.query(
        `INSERT INTO mc.arch_texts (archon_sha, factory_sha, path, text)
         VALUES ($1, 'f', 'loop/commands/loop-check-app.md', $2)`,
        [sha, `${sha} ${prompt}`],
      );
    }

    expect(await db.query(sql('step-detail'), ['other'])).toEqual([]);
    const steps = await db.query(sql('step-detail'), ['mission-control']);
    expect(steps.map((s) => s.depends_on)).toEqual([['subject']]);

    const parts = await db.query(sql('step-prompt'), ['mission-control']);
    expect(parts.length).toBe(3);
    for (const { chunk } of parts) {
      expect(Buffer.byteLength(String(chunk))).toBeLessThan(16 * 1024);
    }
    const texts = joinParts(
      parts as { path: string; part: number; chunk: string }[],
      (row) => row.path,
    );
    expect(texts.get('loop/commands/loop-check-app.md')).toBe(`a2 ${prompt}`);
  });
});
