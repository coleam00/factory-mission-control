import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { SEED_CODEBASE } from '../../scripts/fixture/seed';
import { writeRow } from '../../scripts/fixture/write';
import type { Db } from '../../scripts/lib/db';
import { onTheSeed, queries } from './test-seed';

describe('version-strip on the seed', () => {
  let db: Db;
  const sql = queries.find(([name]) => name === 'version-strip')?.[1] as string;
  const strip = () => db.query(sql, ['mission-control']);

  beforeAll(async () => {
    db = await onTheSeed();
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

  test('pins are shared: a factory with a lap is labelled by them and lists the unused ones, a factory with none lists nothing', async () => {
    const rollback = new Error('rollback');
    await db
      .transaction(async (tx) => {
        await writeRow(tx, 'pin', new Date('2026-10-25T13:00:00Z'));
        const unused = (await tx.query(sql, ['mission-control']))
          .filter((r) => r.digest === null)
          .map((r) => r.pin_sha)
          .sort();
        expect(unused.length).toBeGreaterThan(0);
        expect(await tx.query(sql, ['empty-check'])).toEqual([]);

        await tx.query(`INSERT INTO mc.laps (run_id, factory, workflow_name, status, digest, started_at)
          VALUES ('00000000-0000-0000-0000-0000000000c1', 'north-star', 'archon-loop', 'completed',
            'north-star-digest', '2026-10-20T00:00:00Z')`);
        await tx.query(`INSERT INTO mc.factories (name, repository, codebase, console)
          VALUES ('north-star', 'coleam00/north-star', 'coleam00/north-star', 'http://localhost:3090')`);
        await tx.query(`SELECT mc.project_version('north-star', 'north-star-digest')`);
        const [label] = await tx.query(
          'SELECT sha FROM mc.pins WHERE committed_at < $1 ORDER BY committed_at DESC LIMIT 1',
          ['2026-10-20T00:00:00Z'],
        );
        const rows = await tx.query(sql, ['north-star']);
        expect(rows.filter((r) => r.digest !== null)).toMatchObject([
          { digest: 'north-star-digest', pin_sha: label.sha },
        ]);
        expect(
          rows
            .filter((r) => r.digest === null)
            .map((r) => r.pin_sha)
            .sort(),
        ).toEqual(unused);
        throw rollback;
      })
      .catch((error) => {
        if (error !== rollback) throw error;
      });
  });

  test('a digest only a non-archon-loop run used is not a version and uses up no pin', async () => {
    const rollback = new Error('rollback');
    const digest = 'sha256:fence-proof';
    await db
      .transaction(async (tx) => {
        await writeRow(tx, 'pin', new Date('2026-10-25T14:00:00Z'));
        const [pin] = await tx.query('SELECT sha FROM mc.pins ORDER BY committed_at DESC LIMIT 1');
        await tx.query(
          `INSERT INTO remote_agent_workflow_runs (id, workflow_name, codebase_id, status,
            user_message, metadata, started_at, completed_at, last_activity_at)
          VALUES ('00000000-0000-4000-8000-0000000000f1', 'fence-proof', $1, 'completed', 'Prove the fence',
            $2::jsonb, '2026-10-25T15:00:00Z', '2026-10-25T15:10:00Z', '2026-10-25T15:10:00Z')`,
          [SEED_CODEBASE, JSON.stringify({ workflow_source: { digest } })],
        );
        expect(await tx.query('SELECT factory FROM mc.laps WHERE digest = $1', [digest])).toEqual([
          { factory: 'mission-control' },
        ]);
        expect(await tx.query('SELECT 1 FROM mc.versions WHERE digest = $1', [digest])).toEqual([]);

        const rows = await tx.query(sql, ['mission-control']);
        expect(rows.filter((r) => r.digest === digest)).toEqual([]);
        expect(rows.filter((r) => r.digest === null).map((r) => r.pin_sha)).toContain(pin.sha);
        const scorecardSql = queries.find(([name]) => name === 'scorecard')?.[1] as string;
        const card = await tx.query(scorecardSql, ['mission-control']);
        expect(card.filter((r) => r.digest === digest)).toEqual([]);
        throw rollback;
      })
      .catch((error) => {
        if (error !== rollback) throw error;
      });
  });

  test('a factory whose only runs are non-archon-loop runs lists nothing', async () => {
    const rollback = new Error('rollback');
    await db
      .transaction(async (tx) => {
        await tx.query(`INSERT INTO mc.laps (run_id, factory, workflow_name, status, digest, started_at)
          VALUES ('00000000-0000-0000-0000-0000000000c2', 'fence-only', 'fence-proof', 'completed',
            'sha256:fence-only', '2026-10-25T16:00:00Z')`);
        expect(await tx.query(sql, ['fence-only'])).toEqual([]);
        throw rollback;
      })
      .catch((error) => {
        if (error !== rollback) throw error;
      });
  });

  test('a recorded version no lap qualifies for is still listed, as a version', async () => {
    const rollback = new Error('rollback');
    await db
      .transaction(async (tx) => {
        const [pin] = await tx.query('SELECT sha FROM mc.pins ORDER BY committed_at LIMIT 1');
        await tx.query(
          `INSERT INTO mc.versions (factory, digest, first_run_at, pin_sha)
          VALUES ('mission-control', 'sha256:recorded-only', '2026-10-22T00:00:00Z', $1)`,
          [pin.sha],
        );
        const rows = await tx.query(sql, ['mission-control']);
        expect(rows.filter((r) => r.digest === 'sha256:recorded-only')).toMatchObject([
          { pin_sha: pin.sha },
        ]);
        throw rollback;
      })
      .catch((error) => {
        if (error !== rollback) throw error;
      });
  });
});
