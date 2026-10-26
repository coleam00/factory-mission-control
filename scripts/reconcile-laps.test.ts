import { afterEach, beforeEach, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { archonDb, migrationFiles, snapshot } from '../db/test-db';
import { eventData } from './fixture/write';
import type { Db, Row, Tx } from './lib/db';
import { DATABASE_URL, NOW, recordingDeps, scratchRepo } from './lib/test-deps';
import { runMigrations } from './migrate';
import { main, STEP_EVENT_TYPES } from './reconcile-laps';

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

/**
 * Runs the command against the in-memory database on `branchName`, recording every SQL text.
 * `after` runs on the transaction after each of its statements, to stand in for another session.
 */
async function run(
  argv: string[],
  branchName = 'check-abc',
  after?: (text: string, tx: Tx) => Promise<void>,
) {
  const repoRoot = scratchRepo({ MC_DATABASE_URL: DATABASE_URL });
  scratch.push(repoRoot);
  const recorder = recordingDeps({ repoRoot, branchName });
  const recording = (tx: Tx, hook?: typeof after): Tx => ({
    query: async (text, params) => {
      sql.push(text);
      const result = await tx.query(text, params);
      await hook?.(text, tx);
      return result;
    },
  });
  const deps = {
    ...recorder.deps,
    openDb: (url: string): Db => {
      recorder.opened.push(url);
      return {
        ...recording(db),
        transaction: (fn) => db.transaction((tx) => fn(recording(tx, after))),
        close: async () => {},
      };
    },
  };
  return { code: await main(argv, deps), ...recorder };
}

const rows = (text: string, params: unknown[] = []): Promise<Row[]> => db.query(text, params);

async function archonRun(status: string): Promise<string> {
  const [run] = await rows(
    `INSERT INTO public.remote_agent_workflow_runs (workflow_name, status, user_message, metadata)
     VALUES ('archon-loop', $1, 'Run the loop', '{}') RETURNING id`,
    [status],
  );
  return String(run?.id);
}

/** Archon's event `order` of the run, for one step; `data` defaults to the fixture's for `now`. */
async function archonEvent(
  runId: string,
  order: number,
  step: string,
  event: Parameters<typeof eventData>[1],
  data: Record<string, unknown> = eventData(step, event, NOW),
): Promise<string> {
  // One created_at for every event, so only event_order orders them, as Archon's can.
  const [row] = await rows(
    `INSERT INTO public.remote_agent_workflow_events
       (workflow_run_id, event_order, event_type, step_name, data, created_at)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [runId, order, event, step, JSON.stringify(data), NOW.toISOString()],
  );
  return String(row?.id);
}

async function finish(runId: string): Promise<void> {
  await rows(
    `UPDATE public.remote_agent_workflow_runs SET status = 'completed', completed_at = $2
      WHERE id = $1`,
    [runId, NOW.toISOString()],
  );
}

/** A run Archon finished, with `pick` and `check-app` started and completed. */
async function finishedRun(pickOutput?: unknown): Promise<string> {
  const id = await archonRun('running');
  let order = 0;
  for (const step of ['pick', 'check-app']) {
    for (const event of ['node_started', 'node_completed'] as const) {
      const data = eventData(step, event, NOW);
      if (step === 'pick' && event === 'node_completed' && pickOutput !== undefined) {
        data.structured_output = pickOutput;
      }
      await archonEvent(id, ++order, step, event, data);
    }
  }
  await finish(id);
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

test('a finished run projected before versions gets its version, the same in either order with a late pin, and the next run leaves it alone', async () => {
  await rows(`INSERT INTO mc.factories VALUES
    ('mission-control', 'coleam00/factory-mission-control', 'coleam00/factory-mission-control',
     'http://localhost:3090')`);
  const [codebase] = await rows(`INSERT INTO public.remote_agent_codebases (name)
    VALUES ('coleam00/factory-mission-control') RETURNING id`);
  for (const minutesBefore of [60, 30]) {
    await rows(
      `INSERT INTO public.remote_agent_workflow_runs
         (workflow_name, codebase_id, status, user_message, metadata, started_at, completed_at)
       VALUES ('archon-loop', $1, 'completed', 'Run the loop', $2, $3, $4)`,
      [
        codebase?.id,
        JSON.stringify({ workflow_source: { digest: 'sha256:pack' } }),
        new Date(NOW.getTime() - minutesBefore * 60_000).toISOString(),
        NOW.toISOString(),
      ],
    );
  }
  const versions = () => rows('SELECT * FROM mc.versions');
  const live = await versions();
  expect(live).toEqual([
    {
      factory: 'mission-control',
      digest: 'sha256:pack',
      first_run_at: new Date(NOW.getTime() - 60 * 60_000),
      pin_sha: null,
    },
  ]);

  await rows('DELETE FROM mc.versions');
  expect((await run([])).out).toEqual(['reconcile: 1 run(s) repaired']);
  expect(await versions()).toEqual(live);

  await rows(
    `INSERT INTO mc.pins (sha, archon_sha, reason, committed_at, factory)
     VALUES ('pin', 'archon', 'why', $1, 'mission-control')`,
    [new Date(NOW.getTime() - 90 * 60_000).toISOString()],
  );
  const labelled = await versions();
  expect(labelled).toEqual([{ ...live[0], pin_sha: 'pin' }]);
  expect((await run([])).out).toEqual(['reconcile: 0 run(s) repaired']);

  await rows('DELETE FROM mc.versions');
  const { code, out } = await run([]);
  expect(code).toBe(0);
  expect(out).toEqual(['reconcile: 1 run(s) repaired']);
  expect(await versions()).toEqual(labelled);
});

test('a run whose dropped projection left its lap on an old digest takes its version along', async () => {
  await rows(`INSERT INTO mc.factories VALUES
    ('mission-control', 'coleam00/factory-mission-control', 'coleam00/factory-mission-control',
     'http://localhost:3090')`);
  const [codebase] = await rows(`INSERT INTO public.remote_agent_codebases (name)
    VALUES ('coleam00/factory-mission-control') RETURNING id`);
  const [archon] = await rows(
    `INSERT INTO public.remote_agent_workflow_runs
       (workflow_name, codebase_id, status, user_message, metadata, started_at, completed_at)
     VALUES ('archon-loop', $1, 'completed', 'Run the loop', $2, $3, $3) RETURNING id`,
    [codebase?.id, JSON.stringify({ workflow_source: { digest: 'sha256:new' } }), NOW],
  );
  const projected = await snapshot(db);
  await rows(`UPDATE mc.laps SET digest = 'sha256:old' WHERE run_id = $1`, [archon?.id]);
  await rows(`UPDATE mc.versions SET digest = 'sha256:old'`);

  expect((await run([])).out).toEqual(['reconcile: 1 run(s) repaired']);
  expect(await snapshot(db)).toEqual(projected);
});

test('the replay projects events in Archon order, not the order their rows are stored in', async () => {
  const runId = await archonRun('running');
  const retry = new Date(NOW.getTime() + 60_000);
  const failedFirst = [
    await archonEvent(runId, 1, 'pick', 'node_started'),
    await archonEvent(runId, 2, 'pick', 'node_failed'),
  ];
  await archonEvent(runId, 3, 'pick', 'node_started', eventData('pick', 'node_started', retry));
  await archonEvent(runId, 4, 'pick', 'node_completed', eventData('pick', 'node_completed', retry));
  await finish(runId);
  const projected = await snapshot(db);
  expect(projected.lap_steps?.map((step) => JSON.parse(step).status)).toEqual(['completed']);
  // Rewriting the first attempt's rows stores them after the retry's; no trigger fires on it.
  await rows('UPDATE public.remote_agent_workflow_events SET data = data WHERE id = ANY($1)', [
    failedFirst,
  ]);
  await rows(`UPDATE mc.lap_steps SET status = 'running' WHERE run_id = $1`, [runId]);

  const { code, out } = await run([]);
  expect(code).toBe(0);
  expect(out).toEqual(['reconcile: 1 run(s) repaired']);
  expect(await snapshot(db)).toEqual(projected);
});

test.each(['paused', 'failed'])(
  'a %s run, which may get no more writes, is repaired once',
  async (status) => {
    const runId = await archonRun('running');
    await archonEvent(runId, 1, 'pick', 'node_started');
    await archonEvent(runId, 2, 'pick', 'node_completed');
    await rows('UPDATE public.remote_agent_workflow_runs SET status = $2 WHERE id = $1', [
      runId,
      status,
    ]);
    const projected = await snapshot(db);
    expect(projected.laps?.map((lap) => JSON.parse(lap).status)).toEqual([status]);
    await rows(`UPDATE mc.laps SET status = 'running' WHERE run_id = $1`, [runId]);
    await rows(`UPDATE mc.lap_steps SET status = 'running' WHERE run_id = $1`, [runId]);

    const first = await run([]);
    expect(first.code).toBe(0);
    expect(first.out).toEqual(['reconcile: 1 run(s) repaired']);
    expect(await snapshot(db)).toEqual(projected);

    const second = await run([]);
    expect(second.out).toEqual(['reconcile: 0 run(s) repaired']);
    expect(await snapshot(db)).toEqual(projected);
  },
);

test.each(['running', 'pending'])(
  'a %s run whose lap differs is left to its live triggers and reported',
  async (status) => {
    const runId = await archonRun(status);
    await archonEvent(runId, 1, 'pick', 'node_started');
    await rows(`UPDATE mc.laps SET status = 'paused' WHERE run_id = $1`, [runId]);
    const agreeing = await archonRun(status);
    const before = [...(await tuples(runId)), ...(await tuples(agreeing))];

    const { code, out } = await run([]);
    expect(code).toBe(0);
    expect(out).toEqual([
      'reconcile: 0 run(s) repaired',
      'reconcile: 1 run(s) differ but are still running, left to live triggers',
    ]);
    expect([...(await tuples(runId)), ...(await tuples(agreeing))]).toEqual(before);
  },
);

/** A paused run whose lap a dropped projection left `running`. */
async function wrongPausedLap(): Promise<string> {
  const runId = await archonRun('running');
  await archonEvent(runId, 1, 'pick', 'node_started');
  await rows(`UPDATE public.remote_agent_workflow_runs SET status = 'paused' WHERE id = $1`, [
    runId,
  ]);
  await rows(`UPDATE mc.laps SET status = 'running' WHERE run_id = $1`, [runId]);
  return runId;
}

/** Calls `write` once, right after the replay inserts the run's events. */
const midReplay =
  (write: (tx: Tx) => Promise<void>) =>
  async (text: string, tx: Tx): Promise<void> => {
    if (text.includes('INSERT INTO mc_reconcile_events')) await write(tx);
  };

test('a resume that lands while the replay runs rolls the repair back as busy', async () => {
  const runId = await wrongPausedLap();
  const before = await tuples(runId);

  const { code, out } = await run(
    [],
    'check-abc',
    midReplay(async (tx) => {
      // Stands in for Archon's resume committing in another session (read committed sees it).
      await tx.query(
        `UPDATE public.remote_agent_workflow_runs SET status = 'running' WHERE id = $1`,
        [runId],
      );
    }),
  );
  expect(code).toBe(0);
  expect(out).toEqual([
    'reconcile: 0 run(s) repaired',
    'reconcile: 1 run(s) busy, left for the next run',
  ]);
  expect(await tuples(runId)).toEqual(before);
});

test('a live trigger that lost its lock wait on the run rolls the repair back as busy', async () => {
  const runId = await wrongPausedLap();
  const before = await tuples(runId);

  const { code, out } = await run(
    [],
    'check-abc',
    midReplay(async (tx) => {
      await tx.query(
        `INSERT INTO mc.projection_errors (source, run_id, event_id, sqlstate, message)
         VALUES ('mc_project_step_event', $1, NULL, '55P03', 'canceling statement due to lock timeout')`,
        [runId],
      );
    }),
  );
  expect(code).toBe(0);
  expect(out).toEqual([
    'reconcile: 0 run(s) repaired',
    'reconcile: 1 run(s) busy, left for the next run',
  ]);
  expect(await tuples(runId)).toEqual(before);
});

test('a replay error no live trigger recorded fails that run alone and is reported', async () => {
  const unrecorded = await finishedRun('{"route":"x"}');
  const repairable = await finishedRun();
  const [recorded] = await rows('SELECT message FROM mc.projection_errors');
  // The live trigger's record of the error was itself dropped.
  await rows('DELETE FROM mc.projection_errors');
  await rows(`UPDATE mc.laps SET status = 'running' WHERE run_id = ANY($1)`, [
    [unrecorded, repairable],
  ]);
  const before = await tuples(unrecorded);

  const { code, out, err } = await run([]);
  expect(code).toBe(1);
  expect(out).toEqual(['reconcile: 1 run(s) repaired']);
  expect(err).toEqual([
    `reconcile: run ${unrecorded}: replay hit 22000: ${recorded?.message}`,
    'reconcile: 1 run(s) failed',
  ]);
  expect(await tuples(unrecorded)).toEqual(before);
  expect(await rows('SELECT status FROM mc.laps WHERE run_id = $1', [repairable])).toEqual([
    { status: 'completed' },
  ]);
  expect(await rows('SELECT * FROM mc.projection_errors')).toEqual([]);
});

test('the replay projects the step-level event types the live trigger projects', async () => {
  const [trigger] = await rows(
    `SELECT pg_get_triggerdef(oid) AS def FROM pg_trigger WHERE tgname = 'mc_project_step_event'`,
  );
  const when = / WHEN \((.*)\) EXECUTE /.exec(String(trigger?.def))?.[1] ?? '';
  const types = [...when.matchAll(/'([^']*)'/g)].map((match) => match[1]);
  expect(types.length).toBeGreaterThan(0);
  expect(types.sort()).toEqual([...STEP_EVENT_TYPES].sort());
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
