import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { seededDb } from '../scripts/fixture/seed';
import { writeRow } from '../scripts/fixture/write';
import { REPO_ROOT } from '../scripts/lib/cli';
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
});

describe('version-strip on the seed', () => {
  let db: Db;
  const sql = queries.find(([name]) => name === 'version-strip')?.[1] as string;
  const strip = () => db.query(sql, ['mission-control']);

  beforeAll(async () => {
    db = await seededDb(REPO_ROOT, readFileSync(join(REPO_ROOT, 'fixtures', 'seed.sql'), 'utf8'));
  }, 60_000);

  afterAll(() => db.close());

  test('is one row per seeded version, labelled by the pin committed before its first run', async () => {
    const rows = (await strip()).sort(
      (a, b) =>
        Number(new Date(a.first_run_at as string)) - Number(new Date(b.first_run_at as string)),
    );
    const versions = await db.query(
      'SELECT digest, pin_sha FROM mc.versions WHERE factory = $1 ORDER BY first_run_at',
      ['mission-control'],
    );
    const pins = await db.query('SELECT sha FROM mc.pins ORDER BY committed_at');
    expect(rows.map(({ digest, pin_sha }) => ({ digest, pin_sha }))).toEqual(
      versions.map(({ digest, pin_sha }) => ({ digest, pin_sha })),
    );
    expect(rows.map((r) => r.pin_sha)).toEqual(pins.map((p) => p.sha));
    expect(rows[2]).toMatchObject({ hypothesis: null, measure: null });
  });

  test('each pin written after the last run adds one entry that has not run yet', async () => {
    await db.transaction(async (tx) => {
      await writeRow(tx, 'pin', new Date('2026-10-25T12:00:00Z'));
    });
    const [pin] = await db.query('SELECT sha FROM mc.pins ORDER BY committed_at DESC LIMIT 1');
    const rows = await strip();
    expect(rows).toHaveLength(4);
    expect(rows.filter((r) => r.digest === null).map((r) => r.pin_sha)).toEqual([pin.sha]);

    await db.transaction(async (tx) => {
      await writeRow(tx, 'pin', new Date('2026-10-25T12:03:00Z'));
    });
    expect(await strip()).toHaveLength(5);
  });
});

describe('decisions-timeline and improvements-ledger on the seed', () => {
  let db: Db;
  const named = (name: string) => queries.find(([n]) => n === name)?.[1] as string;
  const timeline = () => db.query(named('decisions-timeline'), ['mission-control']);
  const ledgerRows = () => db.query(named('improvements-ledger'), ['mission-control']);
  const byPin = async (prefix: string) =>
    (await ledgerRows()).find((r) => String(r.pin_sha).startsWith(prefix));

  beforeAll(async () => {
    db = await seededDb(REPO_ROOT, readFileSync(join(REPO_ROOT, 'fixtures', 'seed.sql'), 'utf8'));
  }, 60_000);

  afterAll(() => db.close());

  test('the timeline is every decision, each joined to its pin and that pin’s version by prefix', async () => {
    const versions = await db.query('SELECT digest, pin_sha FROM mc.versions WHERE factory = $1', [
      'mission-control',
    ]);
    const decisions = await db.query('SELECT date::text AS date, title, version FROM mc.decisions');
    const rows = await timeline();
    expect(rows.map((r) => r.title).sort()).toEqual(decisions.map((d) => d.title).sort());
    const joined = rows.filter((r) => r.pin_sha !== null);
    expect(joined).toHaveLength(2);
    for (const row of joined) {
      expect(String(row.pin_sha)).toStartWith(String(row.version));
      expect(versions).toContainEqual({ digest: row.digest, pin_sha: row.pin_sha });
    }
  });

  test('a pin’s laps are this factory’s archon-loop laps of the versions it labels', async () => {
    const counted = await db.query(
      `SELECT v.pin_sha, count(*)::int AS laps FROM mc.laps l
       JOIN mc.versions v ON v.factory = l.factory AND v.digest = l.digest
       WHERE l.factory = $1 AND l.workflow_name = 'archon-loop' GROUP BY v.pin_sha`,
      ['mission-control'],
    );
    const rows = await ledgerRows();
    for (const { pin_sha, laps } of counted) {
      expect(rows.find((r) => r.pin_sha === pin_sha)?.laps).toBe(laps);
    }
    expect(await byPin('8e3e1cef')).toMatchObject({ verdict: 'helped' });
    expect(await byPin('5ffd60c6')).toMatchObject({ verdict: null });
  });

  test('a verdict on V2 by prefix gives V2 that verdict', async () => {
    await db.transaction(async (tx) => {
      await writeRow(tx, 'verdict', new Date('2026-10-25T12:00:00Z'), '5ffd60c6');
    });
    expect(await byPin('5ffd60c6')).toMatchObject({ verdict: 'inconclusive' });
    expect(await byPin('58c5f774')).toMatchObject({ verdict: null });
  });
});
