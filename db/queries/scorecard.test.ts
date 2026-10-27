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
import { SEED_CODEBASE } from '../../scripts/fixture/seed';
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
