import { afterEach, beforeEach, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { archonDb, migrationFiles, snapshot } from '../db/test-db';
import { eventData } from './fixture/write';
import type { Db, Row, Tx } from './lib/db';
import { DATABASE_URL, NOW, recordingDeps, scratchRepo } from './lib/test-deps';
import { runMigrations } from './migrate';
import { main } from './reconcile-laps';

let db: Db;
let sql: string[];
const scratch: string[] = [];

beforeEach(async () => {
  db = await archonDb();
  await runMigrations({ files: migrationFiles, db });
  sql = [];
});
afterEach(async () => {
  await db.close();
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Runs the command against the in-memory database on `branchName`, recording every SQL text. */
async function run(argv: string[], branchName = 'check-abc') {
  const repoRoot = scratchRepo({ MC_DATABASE_URL: DATABASE_URL });
  scratch.push(repoRoot);
  const recorder = recordingDeps({ repoRoot, branchName });
  const recording = (tx: Tx): Tx => ({
    query: (text, params) => {
      sql.push(text);
      return tx.query(text, params);
    },
  });
  const deps = {
    ...recorder.deps,
    openDb: (url: string): Db => {
      recorder.opened.push(url);
      return {
        ...recording(db),
        transaction: (fn) => db.transaction((tx) => fn(recording(tx))),
        close: async () => {},
      };
    },
  };
  return { code: await main(argv, deps), ...recorder };
}

const rows = (text: string, params: unknown[] = []): Promise<Row[]> => db.query(text, params);

/** A run Archon finished, with `pick` and `check-app` started and completed. */
async function finishedRun(pickOutput?: unknown): Promise<string> {
  const [run] = await rows(
    `INSERT INTO public.remote_agent_workflow_runs (workflow_name, status, user_message, metadata)
     VALUES ('archon-loop', 'running', 'Run the loop', '{}') RETURNING id`,
  );
  const id = String(run?.id);
  let order = 0;
  for (const step of ['pick', 'check-app']) {
    for (const event of ['node_started', 'node_completed'] as const) {
      const data = eventData(step, event, NOW);
      if (step === 'pick' && event === 'node_completed' && pickOutput !== undefined) {
        data.structured_output = pickOutput;
      }
      // One created_at for every event, so only event_order orders them, as Archon's can.
      await rows(
        `INSERT INTO public.remote_agent_workflow_events
           (workflow_run_id, event_order, event_type, step_name, data, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, ++order, event, step, JSON.stringify(data), NOW.toISOString()],
      );
    }
  }
  await rows(
    `UPDATE public.remote_agent_workflow_runs SET status = 'completed', completed_at = $2
      WHERE id = $1`,
    [id, NOW.toISOString()],
  );
  return id;
}

async function archonRows(): Promise<string[]> {
  const runs = await rows(
    'SELECT to_jsonb(r)::text AS row FROM public.remote_agent_workflow_runs r',
  );
  const events = await rows(
    'SELECT to_jsonb(e)::text AS row FROM public.remote_agent_workflow_events e',
  );
  return [...runs, ...events].map((r) => String(r.row)).sort();
}

/** The physical identity of each of the run's rows: a rewrite, even to equal values, changes it. */
const tuples = (runId: string) =>
  rows(
    `SELECT ctid::text, xmin::text, to_jsonb(l)::text AS row FROM mc.laps l WHERE run_id = $1
     UNION ALL SELECT ctid::text, xmin::text, to_jsonb(s)::text FROM mc.lap_steps s WHERE run_id = $1
     UNION ALL SELECT ctid::text, xmin::text, to_jsonb(a)::text FROM mc.app_check_lines a
       WHERE run_id = $1
     ORDER BY 3`,
    [runId],
  );

test('a dropped projection is repaired once, an agreeing lap is left alone, and Archon is only read', async () => {
  const dropped = await finishedRun('{"route":"x"}');
  const agreeing = await finishedRun();
  const projected = await snapshot(db);
  expect(projected.projection_errors).toHaveLength(1);
  expect(projected.app_check_lines?.length).toBeGreaterThan(0);
  const archon = await archonRows();

  await rows(`UPDATE mc.laps SET status = 'running', completed_at = NULL WHERE run_id = $1`, [
    dropped,
  ]);
  await rows(`DELETE FROM mc.lap_steps WHERE run_id = $1 AND step_id = 'pick'`, [dropped]);
  await rows(
    `UPDATE mc.lap_steps SET status = 'running' WHERE run_id = $1 AND step_id = 'check-app'`,
    [dropped],
  );
  const untouched = await tuples(agreeing);
  expect(untouched.length).toBeGreaterThan(0);

  const first = await run([]);
  expect(first.code).toBe(0);
  expect(first.out).toEqual(['reconcile: 1 run(s) repaired']);
  expect(await snapshot(db)).toEqual(projected);
  expect(await tuples(agreeing)).toEqual(untouched);

  const second = await run([]);
  expect(second.code).toBe(0);
  expect(second.out).toEqual(['reconcile: 0 run(s) repaired']);
  expect(await snapshot(db)).toEqual(projected);

  expect(await archonRows()).toEqual(archon);
  expect(
    sql.filter((text) =>
      /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(public\.)?remote_agent_/i.test(text),
    ),
  ).toEqual([]);
});

test('a run whose lap was never inserted gets one', async () => {
  const runId = await finishedRun();
  const projected = await snapshot(db);
  await rows('DELETE FROM mc.laps WHERE run_id = $1', [runId]);

  const { code, out } = await run([]);
  expect(code).toBe(0);
  expect(out).toEqual(['reconcile: 1 run(s) repaired']);
  expect(await snapshot(db)).toEqual(projected);
});

test('--help prints usage and exits 0 without opening the database', async () => {
  const { code, out, opened, neonCalls } = await run(['--help']);
  expect(code).toBe(0);
  expect(out.join('\n')).toContain('usage: bun run reconcile:laps');
  expect(opened).toEqual([]);
  expect(neonCalls).toEqual([]);
});

test('an unknown argument exits 2 with usage before touching Neon', async () => {
  const { code, err, neonCalls } = await run(['--force']);
  expect(code).toBe(2);
  expect(err.join('\n')).toContain('usage: bun run reconcile:laps');
  expect(neonCalls).toEqual([]);
});

test('given target branch main, reconcile:laps exits non-zero and opens nothing', async () => {
  const { code, opened, err } = await run([], 'main');
  expect(code).not.toBe(0);
  expect(err.join('\n')).toContain(`refusing branch 'main'`);
  expect(opened).toEqual([]);
});

test('reconcile:laps:main refuses a check branch and writes main', async () => {
  const refused = await run(['--main'], 'check-abc');
  expect(refused.code).not.toBe(0);
  expect(refused.opened).toEqual([]);

  const written = await run(['--main'], 'main');
  expect(written.code).toBe(0);
  expect(written.opened).toEqual([DATABASE_URL]);
  expect(written.out).toEqual(['reconcile: 0 run(s) repaired']);
});
