// `bun run reconcile:laps` (issue #53): repairs the laps a dropped projection left wrong. A
// projection trigger that loses a lock wait records the error, and when even that record fails the
// error is dropped (0006_projection.sql), so a lap can stay `running` after Archon finished the run:
// a finished, paused or failed run may get no more writes to project it again. For each run
// Archon is not running, this replays the run's row and step-level events through 0006's own functions, by way
// of temp tables that carry the same triggers, and keeps the result only when it differs from the
// lap's rows. Archon's tables are only read. It writes the check branch in .mc-check.env; `:main`
// writes `main`, and is the owner's nightly run beside `backfill:main`.

import { parseArgs } from 'node:util';
import { failing, guardedDatabaseUrl, type Main, runCli } from './lib/cli';
import type { Db, Tx } from './lib/db';

/** Thrown to roll back a replay that reproduced the lap's rows, so they are not rewritten. */
class Agrees extends Error {}
/** Thrown to roll back a replay that lost a lock wait, so the next run tries it again. */
class Busy extends Error {}

/** The live trigger's WHEN (0006_projection.sql): the step-level events it projects. */
export const STEP_EVENT_TYPES = ['node_started', 'node_completed', 'node_failed', 'node_skipped'];
/**
 * Archon is writing a run in these, so its next write projects it again. Every other run is
 * replayed: a paused or failed run can be resumed under the same id, which `reproject` detects.
 */
const LIVE = ['pending', 'running'];
/** The run columns the projection reads (0006's mc_project_run_update WHEN), as text. */
const PROJECTED_RUN = `SELECT jsonb_build_array(status, workflow_name, codebase_id, started_at,
    completed_at, metadata -> 'workflow_source' ->> 'digest')::text AS run
  FROM public.remote_agent_workflow_runs WHERE id = $1`;
const REPLAY_RUN = 'mc_reconcile_run';
const REPLAY_STEP_EVENT = 'mc_reconcile_step_event';
/** A constant list as an SQL `IN` list: Archon's names and ours, never input. */
const sqlList = (values: string[]) => `(${values.map((value) => `'${value}'`).join(', ')})`;
const REPLAY_SOURCES = sqlList([REPLAY_RUN, REPLAY_STEP_EVENT]);

/** Every row the projection writes for a run, as text, in a fixed order. */
async function lapRows(tx: Tx, runId: string): Promise<string> {
  const rows = await tx.query(
    `SELECT 'laps' AS t, to_jsonb(l)::text AS row FROM mc.laps l WHERE run_id = $1
     UNION ALL SELECT 'lap_steps', to_jsonb(s)::text FROM mc.lap_steps s WHERE run_id = $1
     UNION ALL SELECT 'app_check_lines', to_jsonb(a)::text FROM mc.app_check_lines a WHERE run_id = $1
     ORDER BY 1, 2`,
    [runId],
  );
  return JSON.stringify(rows);
}

/**
 * Replaces the run's rows with what the projection writes from Archon's rows today. Throws `Agrees`
 * when that is what they already were, `Busy` when the replay could not take a lock or Archon wrote
 * the run while it ran, and an error naming the first projection error the replay hit that no live
 * trigger recorded for the run.
 */
async function reproject(tx: Tx, runId: string): Promise<void> {
  const before = await lapRows(tx, runId);
  const [copied] = await tx.query(PROJECTED_RUN, [runId]);
  const [lastError] = await tx.query(
    'SELECT coalesce(max(id), 0) AS id FROM mc.projection_errors',
    [],
  );
  // The temp tables live only on this transaction's connection, and are dropped with it.
  await tx.query(
    'CREATE TEMP TABLE mc_reconcile_runs (LIKE public.remote_agent_workflow_runs) ON COMMIT DROP',
    [],
  );
  await tx.query(
    'CREATE TEMP TABLE mc_reconcile_events (LIKE public.remote_agent_workflow_events) ON COMMIT DROP',
    [],
  );
  await tx.query(
    `CREATE TRIGGER ${REPLAY_RUN} AFTER INSERT ON mc_reconcile_runs
       FOR EACH ROW EXECUTE FUNCTION mc.project_run()`,
    [],
  );
  await tx.query(
    `CREATE TRIGGER ${REPLAY_STEP_EVENT} AFTER INSERT ON mc_reconcile_events
       FOR EACH ROW EXECUTE FUNCTION mc.project_step_event()`,
    [],
  );
  await tx.query('DELETE FROM mc.app_check_lines WHERE run_id = $1', [runId]);
  await tx.query('DELETE FROM mc.lap_steps WHERE run_id = $1', [runId]);
  await tx.query('DELETE FROM mc.laps WHERE run_id = $1', [runId]);
  await tx.query(
    'INSERT INTO mc_reconcile_runs SELECT * FROM public.remote_agent_workflow_runs WHERE id = $1',
    [runId],
  );
  // Archon's chronology: created_at, then event_order, as its own read queries order events. A
  // replayed start only reopens a step that is running or finished before it, so order matters.
  await tx.query(
    `INSERT INTO mc_reconcile_events SELECT * FROM public.remote_agent_workflow_events
       WHERE workflow_run_id = $1 AND event_type IN ${sqlList(STEP_EVENT_TYPES)}
       ORDER BY created_at, coalesce(event_order, 0), id`,
    [runId],
  );
  const busy = await tx.query(
    `SELECT 1 FROM mc.projection_errors WHERE source IN ${REPLAY_SOURCES} AND sqlstate = '55P03'`,
    [],
  );
  if (busy.length > 0) throw new Busy();
  // A resume of a paused or failed run that commits while this replays would be overwritten by the
  // copy taken before it: read committed, so these see it. Its live trigger may instead have lost
  // its lock wait on the rows this replay holds; either way, roll back and leave the run to the
  // next run of this command. A live write still waiting when this commits gets the rows after it.
  const [current] = await tx.query(PROJECTED_RUN, [runId]);
  const liveBusy = await tx.query(
    `SELECT 1 FROM mc.projection_errors WHERE source NOT IN ${REPLAY_SOURCES}
        AND run_id = $1 AND sqlstate = '55P03' AND id > $2`,
    [runId, lastError?.id],
  );
  if (current?.run !== copied?.run || liveBusy.length > 0) throw new Busy();
  if ((await lapRows(tx, runId)) === before) throw new Agrees();
  // A replay error the live triggers recorded too is already evidence; one they did not (its
  // record dropped, or a cause that came later) rolls the repair back and is reported instead.
  const [unrecorded] = await tx.query(
    `SELECT r.sqlstate, r.message FROM mc.projection_errors r
      WHERE r.source IN ${REPLAY_SOURCES} AND NOT EXISTS (
        SELECT 1 FROM mc.projection_errors l
         WHERE l.source NOT IN ${REPLAY_SOURCES} AND l.run_id = r.run_id
           AND l.event_id IS NOT DISTINCT FROM r.event_id
           AND l.sqlstate = r.sqlstate AND l.message = r.message)
      ORDER BY r.id LIMIT 1`,
    [],
  );
  if (unrecorded) throw new Error(`replay hit ${unrecorded.sqlstate}: ${unrecorded.message}`);
  await tx.query(`DELETE FROM mc.projection_errors WHERE source IN ${REPLAY_SOURCES}`, []);
}

type Reconciled = {
  repaired: number;
  busy: number;
  /** Runs Archon is still running whose lap is missing or shows another status. */
  live: number;
  /** Each run whose repair rolled back on an error, with that error's message. */
  failed: { runId: string; message: string }[];
};

/**
 * Re-projects every Archon run that is not running whose lap rows differ from what its rows project
 * to, and counts the running runs whose lap differs, which it leaves to their live triggers.
 */
export async function reconcileLaps(db: Db): Promise<Reconciled> {
  const runs = await db.query(
    `SELECT id FROM public.remote_agent_workflow_runs WHERE status NOT IN ${sqlList(LIVE)}
      ORDER BY started_at, id`,
    [],
  );
  // Only read, so no live trigger waits on it: a replay would lock the rows Archon's next write
  // projects to. Steps are not compared here; the run's next write projects them again.
  const [live] = await db.query(
    `SELECT count(*)::int AS n FROM public.remote_agent_workflow_runs r
       LEFT JOIN mc.laps l ON l.run_id = r.id
      WHERE r.status IN ${sqlList(LIVE)} AND l.status IS DISTINCT FROM r.status`,
    [],
  );
  const result: Reconciled = { repaired: 0, busy: 0, live: Number(live?.n ?? 0), failed: [] };
  for (const { id } of runs) {
    const runId = String(id);
    try {
      await db.transaction((tx) => reproject(tx, runId));
      result.repaired++;
    } catch (error) {
      if (error instanceof Busy) result.busy++;
      else if (!(error instanceof Agrees)) {
        result.failed.push({
          runId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  return result;
}

const USAGE =
  'usage: bun run reconcile:laps (the check branch in .mc-check.env) | bun run reconcile:laps:main (main, the owner only)';

export const main: Main = async (argv, deps) => {
  let values: { main?: boolean; help?: boolean };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: { main: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } },
    }));
  } catch (error) {
    deps.err(error instanceof Error ? `${error.message}\n${USAGE}` : USAGE);
    return 2;
  }
  if (values.help) {
    deps.out(USAGE);
    return 0;
  }
  return failing(deps, async () => {
    // No terminal prompt for `:main`, like `backfill:main`: the owner schedules the nightly run.
    const url = await guardedDatabaseUrl(deps, values.main ? 'main' : 'check');
    const db = deps.openDb(url);
    try {
      const { repaired, busy, live, failed } = await reconcileLaps(db);
      deps.out(`reconcile: ${repaired} run(s) repaired`);
      if (busy > 0) deps.out(`reconcile: ${busy} run(s) busy, left for the next run`);
      if (live > 0) {
        deps.out(`reconcile: ${live} run(s) differ but are still running, left to live triggers`);
      }
      for (const { runId, message } of failed) deps.err(`reconcile: run ${runId}: ${message}`);
      if (failed.length > 0) throw new Error(`reconcile: ${failed.length} run(s) failed`);
    } finally {
      await db.close();
    }
  });
};

if (import.meta.main) await runCli(main);
