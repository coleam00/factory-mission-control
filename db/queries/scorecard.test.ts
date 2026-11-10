import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  dataValue,
  type MeasureKey,
  type ScorecardRow,
  scorecard,
  versionLaps,
  versionPin,
} from '../../app/lib/scorecard';
import {
  QUEUE_DIGEST,
  QUEUE_DIGEST_2,
  QUEUE_RETURNED,
  QUEUE_RUNS,
  SEED_CODEBASE,
} from '../../scripts/fixture/seed';
import { REPO_ROOT } from '../../scripts/lib/cli';
import type { Db } from '../../scripts/lib/db';
import { onTheSeed, queries } from './test-seed';

describe('scorecard on the seed', () => {
  let db: Db;
  const sql = queries.find(([name]) => name === 'scorecard')?.[1] as string;
  const expected = JSON.parse(
    readFileSync(join(REPO_ROOT, 'fixtures', 'expected-scorecard.json'), 'utf8'),
  ) as {
    versions: { digest: string; measures: Record<string, { value: number; laps: number }> }[];
  };

  beforeAll(async () => {
    db = await onTheSeed();
  }, 60_000);

  afterAll(() => db.close());

  test('every measure of every seed version equals fixtures/expected-scorecard.json', async () => {
    const rows = (await db.query(sql, ['mission-control'])) as unknown as ScorecardRow[];
    expect(expected.versions).toHaveLength(3);
    for (const { digest, measures } of expected.versions) {
      const card = scorecard(versionLaps(rows, digest));
      const shown = Object.fromEntries(
        Object.keys(measures).map((key) => {
          const { value, laps } = card[key as MeasureKey];
          const data = dataValue(value);
          return [key, { value: data === 'n/a' ? null : Number(data), laps: laps.length }];
        }),
      );
      expect({ digest, measures: shown }).toEqual({ digest, measures });
    }
  });

  test("names no other factory's laps or versions", async () => {
    expect(await db.query(sql, ['other'])).toEqual([]);
  });

  test.each([
    ['share one start time', (at: string) => ({ timing: { startedAt: at } })],
    ['carry no start time', () => ({})],
  ])(
    'a lap whose review sent back once and then merged counts every run when its runs %s',
    async (_, timing) => {
      const digest = 'sha256:repeated-review';
      const rollback = new Error('rollback');
      await db
        .transaction(async (tx) => {
          const [run] = await tx.query(
            `INSERT INTO remote_agent_workflow_runs (workflow_name, codebase_id, status, user_message,
             metadata, started_at, completed_at)
           VALUES ('archon-loop', $1, 'completed', 'Run the loop', $2, '2026-10-25T10:00:00Z',
             '2026-10-25T11:00:00Z') RETURNING id`,
            [SEED_CODEBASE, JSON.stringify({ workflow_source: { digest } })],
          );
          const finished = (step: string, at: string, data: object) =>
            tx.query(
              `INSERT INTO remote_agent_workflow_events (workflow_run_id, event_type, step_name, data,
               created_at) VALUES ($1, 'node_completed', $2, $3, $4)`,
              [run?.id, step, JSON.stringify({ ...timing('2026-10-25T10:05:00Z'), ...data }), at],
            );
          const checkApp = { duration_ms: 600_000, cost_usd: 0.5, structured_output: {} };
          const review = (outcome: string) => ({ cost_usd: 0.25, structured_output: { outcome } });
          await finished('pick', '2026-10-25T10:05:00Z', {
            cost_usd: 0.5,
            structured_output: { route: 'complex' },
          });
          await finished('check-app', '2026-10-25T10:15:00Z', checkApp);
          await finished('review', '2026-10-25T10:20:00Z', review('sent-back'));
          await finished('check-app', '2026-10-25T10:40:00Z', checkApp);
          await finished('review', '2026-10-25T10:45:00Z', review('merge'));
          await finished('land', '2026-10-25T10:50:00Z', {
            structured_output: { outcome: 'merged' },
          });

          const rows = (await tx.query(sql, ['mission-control'])) as unknown as ScorecardRow[];
          const card = scorecard(versionLaps(rows, digest));
          expect({
            send_backs: card.send_backs.value,
            cost_per_merge: card.cost_per_merge.value,
            app_check_share: card.app_check_share.value,
          }).toEqual({ send_backs: 1, cost_per_merge: 2, app_check_share: 0.3333 });
          throw rollback;
        })
        .catch((error) => {
          if (error !== rollback) throw error;
        });
    },
  );

  test('a queue-only version counts the build-queue runs that took an item, and no idle run', async () => {
    const rowsOf = async (tx: Pick<Db, 'query'>) =>
      (await tx.query(sql, ['queue-factory'])) as unknown as ScorecardRow[];
    const rows = await rowsOf(db);
    const [{ pin_sha }] = (await db.query(
      `SELECT pin_sha FROM mc.versions WHERE factory = 'queue-factory' AND digest = $1`,
      [QUEUE_DIGEST],
    )) as { pin_sha: string }[];
    expect(
      versionLaps(rows, QUEUE_DIGEST)
        .map((lap) => lap.id)
        .sort(),
    ).toEqual(
      [
        QUEUE_RUNS.built,
        QUEUE_RUNS.build,
        QUEUE_RUNS.review,
        QUEUE_RUNS.ask,
        QUEUE_RETURNED.first,
        QUEUE_RETURNED.second,
      ].sort(),
    );
    expect(versionPin(rows, QUEUE_DIGEST)?.pin).toBe(pin_sha);

    const rollback = new Error('rollback');
    await db
      .transaction(async (tx) => {
        const [{ id }] = (await tx.query(
          `INSERT INTO public.remote_agent_workflow_runs
             (workflow_name, codebase_id, status, user_message, metadata, started_at)
           SELECT 'archon-build-queue', c.id, 'completed', 'idle', $1::jsonb, now()
           FROM public.remote_agent_codebases c WHERE c.name = 'coleam00/queue-factory'
           RETURNING id`,
          [JSON.stringify({ workflow_source: { digest: QUEUE_DIGEST } })],
        )) as { id: string }[];
        await tx.query(
          `INSERT INTO public.remote_agent_workflow_events
             (workflow_run_id, event_type, step_name, data)
           VALUES ($1, 'node_completed', 'facts', $2)`,
          [id, JSON.stringify({ structured_output: { path: 'idle', item: null } })],
        );
        const ids = versionLaps(await rowsOf(tx), QUEUE_DIGEST).map((lap) => lap.id);
        expect(ids).not.toContain(id);
        expect(ids).toHaveLength(6);
        throw rollback;
      })
      .catch((error) => {
        if (error !== rollback) throw error;
      });
  });

  test('queue merges count on the version of the build-queue lap that opened the pull request, equal to a recount', async () => {
    const rowsOf = async (tx: Pick<Db, 'query'>) =>
      (await tx.query(sql, ['queue-factory'])) as unknown as ScorecardRow[];
    const shown = (rows: ScorecardRow[], digest: string) => {
      const { laps, merges, cost_per_merge } = scorecard(versionLaps(rows, digest));
      return {
        laps: laps.value,
        merges: merges.value,
        counted: merges.counted,
        cost: cost_per_merge.value,
      };
    };
    const rows = await rowsOf(db);
    expect(shown(rows, QUEUE_DIGEST)).toEqual({
      laps: 6,
      merges: 1,
      counted: [QUEUE_RUNS.built],
      cost: 5.6,
    });
    expect(shown(rows, QUEUE_DIGEST_2)).toEqual({
      laps: 2,
      merges: 1,
      counted: [QUEUE_RUNS.opened],
      cost: 3,
    });

    // The recount, independent of the TypeScript: for each merged pull request, the build lap on its
    // issue before the first lap that named it (else the last lap before the merge), by version.
    const recount = `
      WITH merged AS (
        SELECT DISTINCT ON (pr) pr, issue, at FROM (
          SELECT (m.value)::int AS pr,
            (SELECT (i -> 'item' ->> 'number')::int FROM jsonb_array_elements(f.output -> 'items') i
              WHERE (i -> 'pr' ->> 'number')::int = (m.value)::int) AS issue,
            rec.completed_at AS at
          FROM mc.laps l
          JOIN mc.lap_steps rec ON rec.run_id = l.run_id AND rec.step_id = 'record'
          JOIN mc.lap_steps f ON f.run_id = l.run_id AND f.step_id = 'facts',
            jsonb_array_elements_text(rec.output -> 'merged') m(value)
          WHERE l.factory = 'queue-factory' AND l.workflow_name = 'archon-merge-queue'
        ) x WHERE issue IS NOT NULL ORDER BY pr, at
      ), builds AS (
        SELECT l.run_id, l.digest, l.started_at, (f.output -> 'item' ->> 'number')::int AS issue,
          (f.output -> 'pull_request' ->> 'number')::int AS pr
        FROM mc.laps l JOIN mc.lap_steps f ON f.run_id = l.run_id AND f.step_id = 'facts'
        WHERE l.factory = 'queue-factory' AND l.workflow_name = 'archon-build-queue'
      ), candidates AS (
        SELECT m.pr AS merged_pr, b.*, row_number() OVER w AS n
        FROM merged m JOIN builds b ON b.issue = m.issue AND b.started_at <= m.at
        WINDOW w AS (PARTITION BY m.pr ORDER BY b.started_at, b.run_id)
      ), named AS (
        SELECT merged_pr, min(n) FILTER (WHERE pr = merged_pr) AS first_named, max(n) AS last_n
        FROM candidates GROUP BY merged_pr
      )
      SELECT c.digest, count(*)::int AS merges
      FROM candidates c JOIN named n ON n.merged_pr = c.merged_pr
      WHERE c.n = CASE WHEN n.first_named IS NULL THEN n.last_n ELSE greatest(n.first_named - 1, 1) END
      GROUP BY c.digest ORDER BY c.digest`;
    expect(await db.query(recount)).toEqual(
      [QUEUE_DIGEST, QUEUE_DIGEST_2].sort().map((digest) => ({ digest, merges: 1 })),
    );

    const rollback = new Error('rollback');
    await db
      .transaction(async (tx) => {
        const [{ id }] = (await tx.query(
          `INSERT INTO public.remote_agent_workflow_runs
             (workflow_name, codebase_id, status, user_message, metadata, started_at, completed_at)
           SELECT 'archon-merge-queue', c.id, 'completed', 'merge', $1::jsonb, now(), now()
           FROM public.remote_agent_codebases c WHERE c.name = 'coleam00/queue-factory'
           RETURNING id`,
          [JSON.stringify({ workflow_source: { digest: QUEUE_DIGEST_2 } })],
        )) as { id: string }[];
        const events: [string, unknown][] = [
          ['facts', { items: [{ item: { number: 404 }, pr: { number: 904 } }] }],
          ['record', { merged: [904] }],
        ];
        for (const [step, structured_output] of events) {
          await tx.query(
            `INSERT INTO public.remote_agent_workflow_events
               (workflow_run_id, event_type, step_name, data)
             VALUES ($1, 'node_completed', $2, $3)`,
            [id, step, JSON.stringify({ structured_output, duration_ms: 1 })],
          );
        }
        // No lap named 904, so the last lap on issue 404 before the merge, version 2's, opened it.
        const after = await rowsOf(tx);
        expect(shown(after, QUEUE_DIGEST).merges).toBe(1);
        expect(shown(after, QUEUE_DIGEST_2).merges).toBe(2);
        throw rollback;
      })
      .catch((error) => {
        if (error !== rollback) throw error;
      });
  });

  test('names each seed version by the pin the version strip names it by', async () => {
    const rows = (await db.query(sql, ['mission-control'])) as unknown as ScorecardRow[];
    const strip = queries.find(([name]) => name === 'version-strip')?.[1] as string;
    const versions = (await db.query(strip, ['mission-control'])).filter((r) => r.digest !== null);
    expect(versions).toHaveLength(3);
    for (const { digest, pin_sha, first_run_at } of versions) {
      expect(versionPin(rows, String(digest))).toEqual({
        firstRunAt: new Date(first_run_at as string),
        pin: pin_sha as string,
      });
    }
  });
});
