import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { SEED_CODEBASE } from '../../scripts/fixture/seed';
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
    const pins = await db.query('SELECT sha, archon_sha FROM mc.pins');
    const rows = await timeline();
    expect(rows.map((r) => r.title).sort()).toEqual(decisions.map((d) => d.title).sort());
    const joined = rows.filter((r) => r.pin_sha !== null);
    expect(joined).toHaveLength(3);
    for (const row of joined) {
      const pin = pins.find((p) => p.sha === row.pin_sha);
      expect(
        [pin?.sha, pin?.archon_sha].some((sha) => String(sha).startsWith(String(row.version))),
      ).toBe(true);
      expect(versions).toContainEqual({ digest: row.digest, pin_sha: row.pin_sha });
    }
    expect(rows.every((r) => r.ambiguous === false)).toBe(true);
  });

  test('Version: a8551bfe links to the pin of Archon a8551bfe, as a prefix of its own sha would', async () => {
    const [v3] = await db.query(
      `SELECT sha FROM mc.pins WHERE starts_with(archon_sha, 'a8551bfe') AND reason IS NULL`,
    );
    const row = (await timeline()).find((r) => r.version === 'a8551bfe');
    expect(row).toMatchObject({ pin_sha: v3?.sha, ambiguous: false });
    expect(row?.digest).not.toBeNull();
  });

  test('Version: none and none (factory consumer ...) link to no pin and are not ambiguous', async () => {
    const rollback = new Error('rollback');
    await db
      .transaction(async (tx) => {
        await tx.query(`INSERT INTO mc.decisions (date, title, decision, why, replaces, version)
          VALUES ('2026-10-16', 'Consume the factory', 'd', 'w', 'r',
            'none (factory consumer of coleam00/ai-software-factory)')`);
        const rows = await tx.query(named('decisions-timeline'), ['mission-control']);
        const none = rows.filter((r) => String(r.version).startsWith('none'));
        expect(none).toHaveLength(2);
        for (const row of none)
          expect(row).toMatchObject({ pin_sha: null, ambiguous: false, digest: null });
        throw rollback;
      })
      .catch((error) => {
        if (error !== rollback) throw error;
      });
  });

  test('a prefix that names two pins, one by its sha and one by its Archon sha, links to neither', async () => {
    const rollback = new Error('rollback');
    await db
      .transaction(async (tx) => {
        await tx.query(
          `INSERT INTO mc.pins (sha, archon_sha, reason, committed_at)
          VALUES ($1, $2, NULL, '2026-10-20T18:00:00Z')`,
          ['f'.repeat(40), `8e3e1cef${'0'.repeat(32)}`],
        );
        await tx.query(
          `INSERT INTO mc.verdicts (sha, pin, verdict, sentence, committed_at)
          VALUES ($1, '5ffd60c6', 'hurt', 'slower.', '2026-10-21T00:00:00Z')`,
          ['e'.repeat(40)],
        );
        const rows = await tx.query(named('decisions-timeline'), ['mission-control']);
        expect(rows.find((r) => r.version === '8e3e1cef')).toMatchObject({
          pin_sha: null,
          ambiguous: true,
          digest: null,
        });
        const ledger = await tx.query(named('improvements-ledger'), ['mission-control']);
        // V1's verdict names 8e3e1cef, now a prefix of two pins: neither has it, and it is listed
        // by its prefix as naming two pins.
        expect(ledger.filter((r) => r.verdict === 'helped')).toEqual([
          expect.objectContaining({ pin_sha: '8e3e1cef', pin_matches: 2, reason: null, laps: 0 }),
        ]);
        expect(ledger.find((r) => String(r.pin_sha).startsWith('5ffd60c6'))).toMatchObject({
          verdict: 'hurt',
          pin_matches: 1,
        });
        throw rollback;
      })
      .catch((error) => {
        if (error !== rollback) throw error;
      });
  });

  test('a digest only another workflow ran after a pin never becomes that pin’s version', async () => {
    const before = await timeline();
    const linked = before.find((r) => r.digest !== null);
    if (!linked) throw new Error('expected a decision linked to a version');
    const [{ committed_at }] = await db.query('SELECT committed_at FROM mc.pins WHERE sha = $1', [
      linked.pin_sha,
    ]);
    const [{ first_run_at }] = await db.query(
      'SELECT first_run_at FROM mc.versions WHERE factory = $1 AND digest = $2',
      ['mission-control', linked.digest],
    );
    const started = new Date(new Date(String(committed_at)).getTime() + 1000);
    expect(started.getTime()).toBeLessThan(new Date(String(first_run_at)).getTime());
    const digest = `sha256:${'f6'.repeat(32)}`;
    const rollback = new Error('rollback');
    await db
      .transaction(async (tx) => {
        await tx.query(
          `INSERT INTO remote_agent_workflow_runs (workflow_name, codebase_id, status, user_message,
           metadata, started_at, completed_at)
           VALUES ('archon-manager', $1, 'completed', 'Manage', $2, $3, $3)`,
          [SEED_CODEBASE, JSON.stringify({ workflow_source: { digest } }), started.toISOString()],
        );
        const [lap] = await tx.query('SELECT factory FROM mc.laps WHERE digest = $1', [digest]);
        expect(lap).toEqual({ factory: 'mission-control' });
        expect(await tx.query(named('decisions-timeline'), ['mission-control'])).toEqual(before);
        throw rollback;
      })
      .catch((error) => {
        if (error !== rollback) throw error;
      });
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

  test('a verdict naming a pin by its Archon sha gives that pin the verdict', async () => {
    const rollback = new Error('rollback');
    await db
      .transaction(async (tx) => {
        await tx.query(
          `INSERT INTO mc.verdicts (sha, pin, verdict, sentence, committed_at)
          VALUES ($1, 'a8551bfe', 'inconclusive', 'too few laps.', '2026-10-26T12:00:00Z')`,
          ['d'.repeat(40)],
        );
        const ledger = await tx.query(named('improvements-ledger'), ['mission-control']);
        const v3 = ledger.find((r) => String(r.pin_sha).startsWith('58c5f774'));
        expect(v3).toMatchObject({ verdict: 'inconclusive', reason: null });
        throw rollback;
      })
      .catch((error) => {
        if (error !== rollback) throw error;
      });
  });

  test('Verdict: a8551bfe on two pins, by one Archon sha and one commit sha, is listed as ambiguous', async () => {
    const rollback = new Error('rollback');
    await db
      .transaction(async (tx) => {
        await tx.query(
          `INSERT INTO mc.verdicts (sha, pin, verdict, sentence, committed_at)
          VALUES ($1, 'a8551bfe', 'hurt', 'slower.', '2026-10-26T12:00:00Z'),
            ($2, 'a8551bfe', 'inconclusive', 'too few laps.', '2026-10-25T12:00:00Z')`,
          ['d'.repeat(40), 'c'.repeat(40)],
        );
        const before = await tx.query(named('improvements-ledger'), ['mission-control']);
        expect(before.find((r) => String(r.pin_sha).startsWith('58c5f774'))).toMatchObject({
          verdict: 'hurt',
        });
        await tx.query(
          `INSERT INTO mc.pins (sha, archon_sha, reason, committed_at)
          VALUES ($1, $2, 'conflict', '2026-10-27T00:00:00Z')`,
          [`a8551bfe${'1'.repeat(32)}`, '2'.repeat(40)],
        );
        const ledger = await tx.query(named('improvements-ledger'), ['mission-control']);
        // V3 (Archon a8551bfe) loses the verdict; the new pin a8551bfe1... never gets it.
        const named8551 = ledger.filter(
          (r) => r.verdict !== null && /^(a8551bfe|58c5f774)/.test(String(r.pin_sha)),
        );
        expect(named8551).toEqual([
          expect.objectContaining({ pin_sha: 'a8551bfe', pin_matches: 2, sentence: 'slower.' }),
        ]);
        expect(ledger.filter((r) => r.pin_matches === 1).length).toBe(
          before.filter((r) => r.pin_matches === 1).length + 1,
        );
        throw rollback;
      })
      .catch((error) => {
        if (error !== rollback) throw error;
      });
  });

  test('a verdict whose prefix names no pin is listed with no pin', async () => {
    const rollback = new Error('rollback');
    await db
      .transaction(async (tx) => {
        await tx.query(
          `INSERT INTO mc.verdicts (sha, pin, verdict, sentence, committed_at)
          VALUES ($1, 'deadbeef', 'helped', 'faster.', '2026-10-26T12:00:00Z')`,
          ['d'.repeat(40)],
        );
        const ledger = await tx.query(named('improvements-ledger'), ['mission-control']);
        expect(ledger.filter((r) => r.pin_sha === 'deadbeef')).toEqual([
          expect.objectContaining({ pin_matches: 0, verdict: 'helped', measure: null }),
        ]);
        expect(await tx.query(named('improvements-ledger'), ['empty-check'])).toEqual([]);
        throw rollback;
      })
      .catch((error) => {
        if (error !== rollback) throw error;
      });
  });
});
