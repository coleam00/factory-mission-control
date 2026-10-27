import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { writeRow } from '../../scripts/fixture/write';
import type { Db } from '../../scripts/lib/db';
import { onTheSeed, queries } from './test-seed';

describe('decisions-timeline and improvements-ledger on the seed', () => {
  let db: Db;
  const named = (name: string) => queries.find(([n]) => n === name)?.[1] as string;
  const timeline = () => db.query(named('decisions-timeline'), ['mission-control']);
  const ledgerRows = () => db.query(named('improvements-ledger'), ['mission-control']);
  const byPin = async (prefix: string) =>
    (await ledgerRows()).find((r) => String(r.pin_sha).startsWith(prefix));

  beforeAll(async () => {
    db = await onTheSeed();
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

  test('decisions are shared but lap counts are each factory’s own; a factory with no laps lists nothing', async () => {
    const rollback = new Error('rollback');
    const ownLaps = (rows: Record<string, unknown>[]) =>
      Object.fromEntries(rows.map((r) => [r.pin_sha, r.laps]));
    const before = ownLaps(await ledgerRows());
    await db
      .transaction(async (tx) => {
        await tx.query(`INSERT INTO mc.factories (name, repository, codebase, console)
          VALUES ('north-star', 'coleam00/north-star', 'coleam00/north-star', 'http://localhost:3090')`);
        await tx.query(`INSERT INTO mc.laps (run_id, factory, workflow_name, status, digest, started_at)
          VALUES ('00000000-0000-0000-0000-0000000000d1', 'north-star', 'archon-loop', 'completed',
            'north-star-digest', '2026-10-20T00:00:00Z'),
          ('00000000-0000-0000-0000-0000000000d2', 'north-star', 'archon-loop', 'completed',
            'north-star-digest', '2026-10-20T01:00:00Z')`);
        const [label] = await tx.query(
          'SELECT sha FROM mc.pins WHERE committed_at < $1 ORDER BY committed_at DESC LIMIT 1',
          ['2026-10-20T00:00:00Z'],
        );
        const titles = async (factory: string) =>
          (await tx.query(named('decisions-timeline'), [factory])).map((r) => r.title).sort();
        expect(await titles('north-star')).toEqual(await titles('mission-control'));
        expect((await titles('north-star')).length).toBeGreaterThan(0);

        const north = ownLaps(await tx.query(named('improvements-ledger'), ['north-star']));
        expect(Object.keys(north).sort()).toEqual(Object.keys(before).sort());
        for (const pin of Object.keys(north)) expect(north[pin]).toBe(pin === label.sha ? 2 : 0);
        expect(ownLaps(await tx.query(named('improvements-ledger'), ['mission-control']))).toEqual(
          before,
        );

        await tx.query(`INSERT INTO mc.factories (name, repository, codebase, console)
          VALUES ('empty-check', 'o/empty', 'o/empty', 'http://localhost:3090')`);
        expect(await tx.query(named('decisions-timeline'), ['empty-check'])).toEqual([]);
        expect(await tx.query(named('improvements-ledger'), ['empty-check'])).toEqual([]);
        throw rollback;
      })
      .catch((error) => {
        if (error !== rollback) throw error;
      });
  });

  test('a verdict on V2 by prefix gives V2 that verdict', async () => {
    await db.transaction(async (tx) => {
      await writeRow(tx, 'verdict', new Date('2026-10-25T12:00:00Z'), '5ffd60c6');
    });
    expect(await byPin('5ffd60c6')).toMatchObject({ verdict: 'inconclusive' });
    expect(await byPin('58c5f774')).toMatchObject({ verdict: null });
  });
});
