import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { RUNS_PAGE_SIZE, type RunsRow, runsArgs, runsView } from '../../app/lib/runs';
import { RUN_STATE, STATES, type State } from '../../app/lib/states';
import { SEED_CODEBASE } from '../../scripts/fixture/seed';
import type { Db } from '../../scripts/lib/db';
import { onTheSeed, queries } from './test-seed';

let db: Db;
beforeAll(async () => {
  db = await onTheSeed();
}, 60_000);
afterAll(() => db.close());

const SQL = queries.find(([n]) => n === 'runs')?.[1] as string;
type Reader = Pick<Db, 'query'>;

/** One page of the screen's query. */
const page = async (
  tx: Reader,
  factory: string,
  {
    q = '',
    state = '',
    hideIdle = true,
    page: n = 1,
  }: Partial<Parameters<typeof runsArgs>[0]> = {},
) =>
  (await tx.query(SQL, [
    factory,
    ...runsArgs({ q, state, hideIdle, page: n }),
  ])) as unknown as RunsRow[];

/** Every run of a chip, page after page. */
async function allRuns(tx: Reader, factory: string, state: State | '', hideIdle: boolean) {
  const runs: ReturnType<typeof runsView>['runs'] = [];
  for (let n = 1; ; n++) {
    const view = runsView(await page(tx, factory, { state, hideIdle, page: n }));
    runs.push(...view.runs);
    if (view.runs.length < RUNS_PAGE_SIZE) return runs;
  }
}

const ROLLBACK = new Error('rollback');
const inRollback = (work: (tx: Reader) => Promise<void>) =>
  db
    .transaction(async (tx) => {
      await work(tx);
      throw ROLLBACK;
    })
    .catch((e) => {
      if (e !== ROLLBACK) throw e;
    });

const FACTORY = 'mission-control';
let nextRun = 0;
const runId = () => `5eed0517-0000-4000-8000-${String(++nextRun).padStart(12, '0')}`;

async function lap(
  tx: Reader,
  workflow: string,
  status: string,
  steps: [string, string, object?][] = [],
  startedAt = '2026-12-01T10:00:00Z',
  factory = FACTORY,
) {
  const id = runId();
  await tx.query(
    `INSERT INTO mc.laps (run_id, factory, workflow_name, status, started_at, completed_at)
     VALUES ($1, $2, $3, $4, $5, $5)`,
    [id, factory, workflow, status, startedAt],
  );
  for (const [step, stepStatus, output] of steps) {
    await tx.query(
      `INSERT INTO mc.lap_steps (run_id, step_id, status, started_at, completed_at, output)
       VALUES ($1, $2, $3, $5, $5, $4::jsonb)`,
      [id, step, stepStatus, output === undefined ? null : JSON.stringify(output), startedAt],
    );
  }
  return id;
}

describe('the runs query on the seed', () => {
  test('the chips count exactly the rows they filter to, from the one query', async () => {
    for (const factory of [FACTORY, 'queue-factory']) {
      for (const hideIdle of [true, false]) {
        const rows = await page(db, factory, { hideIdle });
        const counts = runsView(rows).counts as RunsRow;
        for (const row of rows) {
          expect(
            [
              row.all_count,
              row.running_count,
              row.needs_you_count,
              row.failed_count,
              row.done_count,
              row.idle_count,
              row.idle_polls,
            ],
            'every row carries the same counts',
          ).toEqual([
            counts.all_count,
            counts.running_count,
            counts.needs_you_count,
            counts.failed_count,
            counts.done_count,
            counts.idle_count,
            counts.idle_polls,
          ]);
        }
        const all = await allRuns(db, factory, '', hideIdle);
        expect(all.length).toBe(counts.all_count);
        const byState = new Map<string, string[]>();
        for (const state of STATES) {
          byState.set(
            state,
            (await allRuns(db, factory, state, hideIdle)).map((r) => r.run_id),
          );
        }
        const chip = (state: State) => byState.get(state)?.length;
        expect([
          chip('running'),
          chip('needs-you'),
          chip('failed'),
          chip('done'),
          chip('idle'),
        ]).toEqual([
          counts.running_count,
          counts.needs_you_count,
          counts.failed_count,
          counts.done_count,
          counts.idle_count,
        ]);
        expect(
          [...byState.values()].reduce((sum, ids) => sum + ids.length, 0),
          'the chips add up to All',
        ).toBe(counts.all_count);
        expect([...byState.values()].flat().sort()).toEqual(all.map((r) => r.run_id).sort());
      }
    }
  });

  test('every run says why it stopped as its stop record does', async () => {
    const stops = new Map<string, (string | null)[]>(
      (await db.query('SELECT run_id::text AS id, step_id, line FROM mc.run_stops')).map((r) => [
        String(r.id),
        [r.step_id as string | null, r.line as string | null],
      ]),
    );
    const runs = await allRuns(db, FACTORY, '', false);
    expect(runs.some((r) => r.state === 'failed' && r.stop_line !== null)).toBe(true);
    for (const run of runs) {
      expect([run.stop_step, run.stop_line]).toEqual(stops.get(run.run_id) ?? [null, null]);
    }
  });

  test('another factory sees none of these runs', async () => {
    const [row, ...rest] = await page(db, 'other');
    expect(rest).toEqual([]);
    expect(row).toMatchObject({ all_count: 0, idle_polls: 0, run_id: null });
  });
});

describe('the runs query on rows it inserts', () => {
  test('each Archon status lands on the state RUN_STATE gives it', () =>
    inRollback(async (tx) => {
      const ids = new Map<string, string>();
      for (const status of [...Object.keys(RUN_STATE), 'something-new']) {
        ids.set(status, await lap(tx, 'archon-merge-queue', status));
      }
      const runs = (await allRuns(tx, FACTORY, '', false)).filter((r) =>
        [...ids.values()].includes(r.run_id),
      );
      expect(runs.map((r) => [r.status, r.state]).sort()).toEqual(
        [...ids.keys()]
          .map((status) => [status, RUN_STATE[status as keyof typeof RUN_STATE] ?? 'idle'])
          .sort(),
      );
    }));

  test('hiding idle polls takes out exactly the idle number, and no failed run or other check is one', () =>
    inRollback(async (tx) => {
      const before = await page(tx, FACTORY, { hideIdle: false });
      const idleFacts = await lap(tx, 'archon-merge-queue', 'completed', [
        ['facts', 'completed', { path: 'idle' }],
      ]);
      const idleCheck = await lap(tx, 'factory-app-check', 'completed', [
        ['config', 'completed'],
        ['select', 'completed'],
        ['pending', 'skipped'],
        ['scope', 'skipped'],
        ['finalize', 'completed'],
        ['cleanup', 'completed'],
      ]);
      const failedFacts = await lap(tx, 'archon-merge-queue', 'failed', [
        ['facts', 'completed', { path: 'idle' }],
      ]);
      const workedFacts = await lap(tx, 'archon-merge-queue', 'completed', [
        ['facts', 'completed', { path: 'route' }],
      ]);
      const worked = await lap(tx, 'factory-app-check', 'completed', [
        ['config', 'completed'],
        ['select', 'completed'],
        ['pending', 'completed'],
      ]);
      const empty = await lap(tx, 'factory-app-check', 'completed');
      const idle = new Set([idleFacts, idleCheck]);

      const shown = await page(tx, FACTORY, { hideIdle: false });
      const hidden = await page(tx, FACTORY, { hideIdle: true });
      const [s, h] = [shown, hidden].map((rows) => runsView(rows).counts as RunsRow);
      expect(s.all_count - (before[0]?.all_count ?? 0)).toBe(6);
      expect(s.idle_polls).toBe(2);
      expect(h.idle_polls).toBe(2);
      expect(s.all_count - h.all_count).toBe(2);
      expect(s.done_count - h.done_count).toBe(2);
      const ids = (rows: RunsRow[]) => runsView(rows).runs.map((r) => r.run_id);
      expect(
        ids(shown)
          .filter((id) => idle.has(id))
          .sort(),
      ).toEqual([...idle].sort());
      expect(ids(hidden).filter((id) => idle.has(id))).toEqual([]);
      for (const kept of [failedFacts, workedFacts, worked, empty]) {
        expect(ids(hidden)).toContain(kept);
      }
    }));

  test("a build run's cost leaves out its loop roll-up and equals its steps' attempts", () =>
    inRollback(async (tx) => {
      const [run] = await tx.query(
        `INSERT INTO remote_agent_workflow_runs (workflow_name, codebase_id, status, user_message,
         metadata, started_at)
         VALUES ('archon-build-queue', $1, 'running', 'Build', '{}', '2026-10-25T10:00:00Z')
         RETURNING id`,
        [SEED_CODEBASE],
      );
      const id = String(run?.id);
      const event = (step: string, at: string, data: object) =>
        tx.query(
          `INSERT INTO remote_agent_workflow_events (workflow_run_id, event_type, step_name, data,
           created_at) VALUES ($1, 'node_completed', $2, $3, $4)`,
          [id, step, JSON.stringify({ timing: { startedAt: at }, ...data }), at],
        );
      await event('implement', '2026-10-25T10:05:00Z', { cost_usd: 0.5 });
      await event('review', '2026-10-25T10:10:00Z', { cost_usd: 0.25 });
      await event('ship__deliver__rounds', '2026-10-25T10:15:00Z', {
        cost_usd: 0.75,
        aggregate: true,
      });
      const row = (await allRuns(tx, FACTORY, '', false)).find((r) => r.run_id === id);
      const [attempts] = await tx.query(
        'SELECT sum(cost_usd)::float8 AS c FROM mc.lap_step_attempts WHERE run_id = $1',
        [id],
      );
      expect(Number(row?.cost_usd)).toBeCloseTo(0.75, 9);
      expect(Number(row?.cost_usd)).toBe(Number(attempts?.c));
    }));

  test('a search finds a run by workflow, item, title, run id and error text, and the idle count follows it', () =>
    inRollback(async (tx) => {
      await tx.query(
        `INSERT INTO mc.issues (factory, number, title, state, url, created_at, updated_at)
         VALUES ($1, 9517, 'Findable title ZEBRA', 'open', 'u', now(), now())`,
        [FACTORY],
      );
      const id = await lap(tx, 'archon-zebra-queue', 'failed', [
        ['facts', 'completed', { item: { number: 9517 } }],
        ['build', 'failed'],
      ]);
      await tx.query(
        `UPDATE mc.lap_steps SET error = 'exploded in QUUX' WHERE run_id = $1 AND step_id = 'build'`,
        [id],
      );
      const idle = await lap(tx, 'archon-zebra-idle', 'completed', [
        ['facts', 'completed', { path: 'idle' }],
      ]);
      for (const q of ['archon-zebra-queue', '#9517', 'findable title zebra', id, 'QUUX']) {
        const view = runsView(await page(tx, FACTORY, { q, hideIdle: false }));
        expect([q, view.runs.map((r) => r.run_id)]).toEqual([q, [id]]);
        expect(view.counts?.all_count).toBe(1);
        expect(view.counts?.idle_polls).toBe(0);
      }
      const zebras = runsView(await page(tx, FACTORY, { q: 'zebra' }));
      expect(zebras.counts?.idle_polls).toBe(1);
      expect(zebras.runs.map((r) => r.run_id)).toContain(id);
      expect(zebras.runs.map((r) => r.run_id)).not.toContain(idle);
    }));

  test('pages hold a page of runs, newest first, and a page past the end still carries the counts', () =>
    inRollback(async (tx) => {
      const total = (await page(tx, FACTORY, { hideIdle: false }))[0]?.all_count ?? 0;
      const ids: string[] = [];
      for (let n = 0; n < 120; n++) {
        const day = String(1 + Math.floor(n / 24)).padStart(2, '0');
        const hour = String(n % 24).padStart(2, '0');
        ids.push(
          await lap(tx, 'archon-page-test', 'completed', [], `2027-03-${day}T${hour}:00:00Z`),
        );
      }
      const first = await page(tx, FACTORY, { hideIdle: false });
      const second = await page(tx, FACTORY, { hideIdle: false, page: 2 });
      const last = await page(tx, FACTORY, { hideIdle: false, page: 3 });
      expect(first.map((r) => r.position)).toEqual(
        Array.from({ length: RUNS_PAGE_SIZE }, (_, i) => i + 1),
      );
      expect(first.map((r) => r.run_id)).toEqual(ids.toReversed().slice(0, RUNS_PAGE_SIZE));
      expect(second.map((r) => r.run_id)).toEqual(
        ids.toReversed().slice(RUNS_PAGE_SIZE, 2 * RUNS_PAGE_SIZE),
      );
      expect(last.length).toBe(Math.min(RUNS_PAGE_SIZE, total + 20));
      const past = await page(tx, FACTORY, { hideIdle: false, page: 40 });
      expect(past).toHaveLength(1);
      expect(past[0]).toMatchObject({ run_id: null, all_count: total + 120 });
    }));
});
