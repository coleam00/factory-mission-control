import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Db } from '../../scripts/lib/db';
import { migratedDb, queries } from './test-seed';

describe('against the migrated schema', () => {
  let db: Db;

  beforeAll(async () => {
    db = await migratedDb();
  });

  afterAll(() => db.close());

  test('status-strip counts one factory’s running runs of every workflow and nothing else', async () => {
    await db.query(`INSERT INTO mc.laps (run_id, factory, workflow_name, status) VALUES
      ('00000000-0000-0000-0000-0000000000a1', 'mission-control', 'archon-loop', 'running'),
      ('00000000-0000-0000-0000-0000000000a2', 'mission-control', 'archon-loop', 'running'),
      ('00000000-0000-0000-0000-0000000000a3', 'mission-control', 'archon-loop', 'completed'),
      ('00000000-0000-0000-0000-0000000000a5', 'mission-control', 'archon-manager', 'running'),
      ('00000000-0000-0000-0000-0000000000a4', 'other', 'archon-loop', 'running')`);
    const sql = queries.find(([name]) => name === 'status-strip')?.[1] as string;
    expect(await db.query(sql, ['mission-control'])).toEqual([
      { running: 3, waiting: 0, engine: null },
    ]);
    expect(await db.query(sql, ['other'])).toEqual([{ running: 1, waiting: 0, engine: null }]);
  });

  test('status-strip counts the factory’s runs waiting for a slot and names its newest pin’s engine', async () => {
    await db.query(`INSERT INTO mc.capacity_waits (run_id, factory, workflow_name, since) VALUES
      ('00000000-0000-0000-0000-0000000000b1', 'mission-control', 'archon-build-queue', now()),
      ('00000000-0000-0000-0000-0000000000b2', 'other', 'archon-build-queue', now())`);
    await db.query(`INSERT INTO mc.factories VALUES
      ('mission-control', 'o/mc', 'o/mc', 'http://localhost:3090'),
      ('other', 'o/other', 'o/other', 'http://localhost:3091')`);
    await db.query(`INSERT INTO mc.pins (sha, archon_sha, reason, committed_at) VALUES
      ('p1', 'aaaa1111', 'older', '2026-01-01'), ('p2', 'bbbb2222', 'newer', '2026-02-01')`);
    await db.query(`INSERT INTO mc.arch_versions (archon_sha, factory_sha, parsed_at) VALUES
      ('aaaa1111', 'f1', '2026-03-01'), ('bbbb2222', 'f2', '2026-01-01'), ('cccc3333', 'f3', '2026-04-01')`);
    await db.query(`INSERT INTO mc.versions (factory, digest, first_run_at, pin_sha) VALUES
      ('mission-control', 'd1', '2026-01-02', 'p1'), ('mission-control', 'd2', '2026-02-02', 'p2'),
      ('other', 'd3', '2026-03-01', NULL)`);
    const sql = queries.find(([name]) => name === 'status-strip')?.[1] as string;
    const [mc] = await db.query(sql, ['mission-control']);
    expect([mc?.waiting, mc?.engine]).toEqual([1, 'bbbb2222']);
    const [other] = await db.query(sql, ['other']);
    expect([other?.waiting, other?.engine]).toEqual([1, 'bbbb2222']);
  });

  test('status-strip names, on a queue factory, the architecture parsed last', async () => {
    await db.query(`INSERT INTO mc.laps (run_id, factory, workflow_name, status) VALUES
      ('00000000-0000-0000-0000-0000000000c1', 'mission-control', 'archon-build-queue', 'completed')`);
    const sql = queries.find(([name]) => name === 'status-strip')?.[1] as string;
    const [mc] = await db.query(sql, ['mission-control']);
    expect(mc?.engine).toBe('cccc3333');
  });
});
