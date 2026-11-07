import { afterAll, beforeAll, expect, test } from 'bun:test';
import { NO_REASON, type WorkItemRow, workItemTimeline } from '../../app/lib/work-item';
import { QUEUE_RETURNED } from '../../scripts/fixture/seed';
import { MARKER } from '../../scripts/fixture/seed-report';
import type { Db } from '../../scripts/lib/db';
import { onTheSeed, queries } from './test-seed';

let db: Db;
beforeAll(async () => {
  db = await onTheSeed();
}, 60_000);
afterAll(() => db.close());

const SQL = queries.find(([n]) => n === 'work-item')?.[1] as string;
const rowsOf = async (tx: Pick<Db, 'query'>, factory: string, number: number) =>
  (await tx.query(SQL, [factory, String(number)])) as unknown as WorkItemRow[];
const lines = async (factory: string, number: number, tx: Pick<Db, 'query'> = db) =>
  workItemTimeline(await rowsOf(tx, factory, number), factory).map((e) => e.text);

const ROLLBACK = new Error('rollback');
const inRollback = (work: (tx: Pick<Db, 'query'>) => Promise<void>) =>
  db
    .transaction(async (tx) => {
      await work(tx);
      throw ROLLBACK;
    })
    .catch((e) => {
      if (e !== ROLLBACK) throw e;
    });

test('a work item returned by a sweep and merged later shows both, with the brief, in order', async () => {
  const events = workItemTimeline(
    await rowsOf(db, 'queue-factory', QUEUE_RETURNED.issue),
    'queue-factory',
  );
  expect(events.map((e) => e.text)).toEqual([
    'Filed',
    'Intake: route deliver, size m',
    'Round 1: 2 deliveries, 0:09:00, $2.20, then Ready',
    'Review: Ready',
    `Returned to Build: ${QUEUE_RETURNED.reason}`,
    'Round 2: 1 delivery, 0:09:00, $2.20, then Ready',
    'Review: Ready',
    'Merged',
  ]);
  expect(events.find((e) => e.text.startsWith('Returned'))?.detail).toBe(
    `Brief: ${QUEUE_RETURNED.brief}`,
  );
});

test('a refused land attempt shows its stored reason verbatim, and says so when there is none', async () => {
  const refusals = (all: string[]) => all.filter((t) => t.startsWith('Merge gate refused'));
  expect(refusals(await lines('mission-control', 3))).toEqual([
    'Merge gate refused: it changes .claude/settings.json, which only the owner changes',
    'Merge gate refused: the commit does not contain the current default branch',
  ]);
  await inRollback(async (tx) => {
    await tx.query(
      `UPDATE mc.lap_steps SET output = '{"outcome":"refused","reason":""}'::jsonb
       WHERE step_id = 'land' AND output ->> 'reason' LIKE 'it changes%'`,
    );
    expect(refusals(await lines('mission-control', 3, tx))[0]).toBe(
      `Merge gate refused. ${NO_REASON}`,
    );
  });
});

test('no hidden check line or text reaches the page, on any work item', async () => {
  const numbers = (await db.query(
    `SELECT number FROM mc.issues WHERE factory = 'mission-control'`,
  )) as unknown as { number: number }[];
  for (const { number } of numbers) {
    const rows = await rowsOf(db, 'mission-control', number);
    expect(JSON.stringify(rows)).not.toContain(MARKER);
    expect(rows.some((r) => r.line_kind === 'holdout')).toBe(false);
  }
  expect(SQL).toContain("a.kind <> 'holdout'");
  for (const word of ['dispositions', 'hidden_lines', 'scenario_id'])
    expect(SQL).not.toContain(word);
});

test('a build-queue run is on the item once its facts step names it, or while that step has not finished', async () => {
  await inRollback(async (tx) => {
    const start = async (facts: Record<string, unknown> | null, status: string) => {
      const [{ id }] = (await tx.query(
        `INSERT INTO public.remote_agent_workflow_runs
           (workflow_name, codebase_id, status, user_message, metadata, started_at)
         SELECT 'archon-build-queue', c.id, $1, 'probe', $2::jsonb, now()
         FROM public.remote_agent_codebases c WHERE c.name = 'coleam00/queue-factory'
         RETURNING id`,
        [status, JSON.stringify({ inputs: { number: '407' } })],
      )) as { id: string }[];
      if (facts !== null)
        await tx.query(
          `INSERT INTO public.remote_agent_workflow_events (workflow_run_id, event_type, step_name, data)
           VALUES ($1, 'node_completed', 'facts', $2)`,
          [id, JSON.stringify({ structured_output: facts })],
        );
      return id;
    };
    const idle = await start({ path: 'idle', item: null }, 'completed');
    const starting = await start(null, 'running');
    const ids = (await rowsOf(tx, 'queue-factory', 407))
      .filter((r) => r.kind === 'run')
      .map((r) => r.run_id);
    expect(ids).not.toContain(idle);
    expect(ids).toContain(starting);
  });
});

test("a build run's cost is its non-aggregate steps, not its loop roll-up on top", async () => {
  const runs = (await rowsOf(db, 'queue-factory', QUEUE_RETURNED.issue)).filter(
    (r) => r.workflow === 'archon-build-queue',
  );
  expect(runs).toHaveLength(2);
  for (const run of runs) {
    expect(run.cost).toBeCloseTo(2.2, 9);
    const [rollup] = await db.query(
      `SELECT cost_usd::float8 AS c FROM mc.lap_steps
       WHERE run_id = $1 AND step_id = 'ship__deliver__rounds'`,
      [run.run_id],
    );
    expect(rollup.c).toBe(1.5);
  }
});
