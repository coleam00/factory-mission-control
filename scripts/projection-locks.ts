import { eventData, WORKFLOW } from './fixture/write';
import { failing, guardedDatabaseUrl, type Main, noArguments, runCli } from './lib/cli';
import type { Db, Tx } from './lib/db';
import { reconcileLaps } from './reconcile-laps';

const USAGE = 'usage: bun run projection:locks (the check branch in .mc-check.env)';

/**
 * How much longer than the unlocked write a locked one may take: the projection's own wait and
 * its error record's, 100 ms each (0006_projection.sql), with room for the network.
 */
export const BOUND_MS = 400;

/** Archon's write gets a statement timeout, so a wait the projection does not stop ends as a failure. */
const ARCHON_STATEMENT_TIMEOUT = '5s';

type Lock =
  | { mode: 'table'; tables: string[] }
  | { mode: 'row'; table: string; column: string; where: string };

type Case = {
  name: string;
  /** What a second session holds, in an open transaction, while Archon writes. */
  lock?: Lock;
  /** The projection errors Archon's write should leave: one when the projection gave up. */
  errors: number;
  /** A table of Archon's the write goes through; where it is absent no projection trigger exists, so the case is skipped. */
  needs?: string;
  write: (tx: Tx, runId: string) => Promise<unknown>;
};

const stepEvent = (step: string) => (tx: Tx, runId: string) =>
  tx.query(
    `INSERT INTO remote_agent_workflow_events (workflow_run_id, event_type, step_name, data)
     VALUES ($1, 'node_completed', $2, $3::jsonb)`,
    [runId, step, eventData(step, 'node_completed', new Date())],
  );

const newStatus = (tx: Tx, runId: string) =>
  tx.query(
    `UPDATE remote_agent_workflow_runs
     SET status = CASE status WHEN 'running' THEN 'paused' ELSE 'running' END WHERE id = $1`,
    [runId],
  );

const newRun = (tx: Tx) =>
  tx.query(
    `INSERT INTO remote_agent_workflow_runs (workflow_name, status, user_message, metadata)
     VALUES ('projection-locks', 'running', 'lock wait check', '{}'::jsonb)`,
  );

const providerEvent = (tx: Tx, runId: string) =>
  tx.query(
    `INSERT INTO remote_agent_workflow_events (workflow_run_id, event_type, step_name, data)
     VALUES ($1, 'provider_event', 'pick', '{"type":"assistant"}'::jsonb)`,
    [runId],
  );

/** The first factory by name whose codebase is on the branch, which the version cases run. */
const FACTORY_CODEBASE = `FROM remote_agent_codebases c JOIN mc.factories f ON f.codebase = c.name
  ORDER BY f.name LIMIT 1`;

/** The digest every version case runs, one per run of this script. */
const loopDigest = (runId: string) => `projection-locks:${runId}`;

/**
 * A finished archon-loop run of the factory, `daysBefore` days ago: earlier than every earlier
 * case's, so its version's first run moves and the projection must write the version row.
 */
const loopRun = (daysBefore: number) => (tx: Tx, runId: string) =>
  tx.query(
    `INSERT INTO remote_agent_workflow_runs
       (workflow_name, codebase_id, status, user_message, metadata, started_at)
     SELECT $3, c.id, 'completed', 'lock wait check',
       jsonb_build_object('workflow_source', jsonb_build_object('digest', $1::text)),
       now() - make_interval(days => $2::int)
     ${FACTORY_CODEBASE}`,
    [loopDigest(runId), daysBefore, WORKFLOW],
  );

/** A fresh run Archon's write moves to `update`, so the triggers on its UPDATE run. */
const updatedRun = (update: string) => async (tx: Tx) => {
  const [run] = await tx.query(
    `INSERT INTO remote_agent_workflow_runs (workflow_name, status, user_message, metadata)
     VALUES ('projection-locks', 'running', 'lock wait check', '{}'::jsonb) RETURNING id`,
  );
  await tx.query(`UPDATE remote_agent_workflow_runs SET ${update} WHERE id = $1`, [run?.id]);
};

const stoppedRun = updatedRun(`status = 'failed', completed_at = now()`);

/** An answered capacity wait: the projection writes mc.capacity_waits for it. */
const capacityWaitRun = updatedRun(
  `status = 'paused', metadata = jsonb_build_object(
     'wait', jsonb_build_object('kind', 'attention', 'answer', 'wait', 'message', 'capacity'),
     'capacity_wait', jsonb_build_object('since', now()))`,
);

/** The work item every state case writes, one revision above the last. */
const WORK_PROJECT = 'projection-locks';
const WORK_NAME = 'work/999999999';
const parkedOn =
  '{"facts":{"build":{"status":"parked","at":"T","decisions":[{"reason":"waits on #7"}]}}}';

const WORK_STATE_TABLE = 'remote_agent_state_revisions';

const workState = (tx: Tx) =>
  tx.query(
    `INSERT INTO ${WORK_STATE_TABLE} (project_key, name, revision, value, operation, writer_kind)
     SELECT $1, $2, coalesce(max(revision), 0) + 1, $3, 'put', 'run'
     FROM ${WORK_STATE_TABLE} WHERE project_key = $1 AND name = $2`,
    [WORK_PROJECT, WORK_NAME, parkedOn],
  );

const exclusive = (...tables: string[]): Lock => ({ mode: 'table', tables });

const rowLock = (table: string, column: string, where: string): Lock => ({
  mode: 'row',
  table,
  column,
  where,
});

/** The SQL a second session runs to take `lock`: ACCESS EXCLUSIVE on tables, or an uncommitted no-op UPDATE of rows. */
export const holdSql = (lock: Lock): string =>
  lock.mode === 'table'
    ? `LOCK TABLE ${lock.tables.map((table) => `mc.${table}`).join(', ')} IN ACCESS EXCLUSIVE MODE`
    : `UPDATE mc.${lock.table} SET ${lock.column} = ${lock.column} WHERE ${lock.where}`;

/**
 * Every mc table a projection function reads or writes in Archon's transaction. The all-tables
 * case locks this list; projection-locks.test.ts fails when it differs from the mc tables the mc
 * functions reference.
 */
export const PROJECTION_TABLES = [
  'laps',
  'lap_steps',
  'lap_step_attempts',
  'lap_step_attempt_usage',
  'app_check_lines',
  'attention_items',
  'run_stops',
  'capacity_waits',
  'work_item_states',
  'work_item_blockers',
  'factories',
  'versions',
  'pins',
  'projection_errors',
];

export const CASES: Case[] = [
  { name: 'no lock: node_completed', errors: 0, write: stepEvent('pick') },
  {
    name: 'ACCESS EXCLUSIVE mc.lap_steps: node_completed',
    lock: exclusive('lap_steps'),
    errors: 1,
    write: stepEvent('pick'),
  },
  {
    name: 'uncommitted UPDATE of the same mc.lap_steps row: node_completed',
    lock: rowLock('lap_steps', 'error', "run_id = $1 AND step_id = 'pick'"),
    errors: 1,
    write: stepEvent('pick'),
  },
  {
    name: 'ACCESS EXCLUSIVE mc.lap_step_attempts: node_completed',
    lock: exclusive('lap_step_attempts'),
    errors: 1,
    write: stepEvent('pick'),
  },
  {
    name: 'ACCESS EXCLUSIVE mc.lap_step_attempt_usage: node_completed',
    lock: exclusive('lap_step_attempt_usage'),
    errors: 1,
    write: stepEvent('pick'),
  },
  {
    name: 'ACCESS EXCLUSIVE mc.app_check_lines: check-app node_completed',
    lock: exclusive('app_check_lines'),
    errors: 1,
    write: stepEvent('check-app'),
  },
  {
    name: 'ACCESS EXCLUSIVE mc.laps: run status UPDATE',
    lock: exclusive('laps'),
    errors: 1,
    write: newStatus,
  },
  {
    name: 'ACCESS EXCLUSIVE mc.attention_items: run status UPDATE',
    lock: exclusive('attention_items'),
    errors: 1,
    write: newStatus,
  },
  {
    name: 'uncommitted UPDATE of the same mc.laps row: run status UPDATE',
    lock: rowLock('laps', 'status', 'run_id = $1'),
    errors: 1,
    write: newStatus,
  },
  {
    name: 'ACCESS EXCLUSIVE mc.factories: run INSERT',
    lock: exclusive('factories'),
    errors: 1,
    write: newRun,
  },
  {
    name: 'ACCESS EXCLUSIVE mc.lap_steps and mc.projection_errors: node_completed',
    lock: exclusive('lap_steps', 'projection_errors'),
    errors: 0,
    write: stepEvent('pick'),
  },
  {
    name: 'ACCESS EXCLUSIVE on every mc table the projection writes: provider_event',
    lock: exclusive(...PROJECTION_TABLES),
    errors: 0,
    write: providerEvent,
  },
  {
    name: 'ACCESS EXCLUSIVE mc.run_stops: run INSERT then finished as failed (two waits)',
    lock: exclusive('run_stops'),
    errors: 2,
    write: stoppedRun,
  },
  {
    name: 'ACCESS EXCLUSIVE mc.capacity_waits: answered capacity wait',
    lock: exclusive('capacity_waits'),
    errors: 1,
    write: capacityWaitRun,
  },
  {
    name: 'ACCESS EXCLUSIVE mc.work_item_states: work item state revision',
    lock: exclusive('work_item_states'),
    errors: 1,
    needs: WORK_STATE_TABLE,
    write: workState,
  },
  {
    name: 'ACCESS EXCLUSIVE mc.work_item_blockers: work item state revision',
    lock: exclusive('work_item_blockers'),
    errors: 1,
    needs: WORK_STATE_TABLE,
    write: workState,
  },
  { name: 'no lock: archon-loop run INSERT with a new digest', errors: 0, write: loopRun(0) },
  {
    name: "ACCESS EXCLUSIVE mc.versions: archon-loop run INSERT that moves its version's first run",
    lock: exclusive('versions'),
    errors: 1,
    write: loopRun(1),
  },
  {
    name: "uncommitted UPDATE of the same mc.versions row: archon-loop run INSERT that moves its version's first run",
    lock: rowLock('versions', 'pin_sha', "digest = 'projection-locks:' || $1::text"),
    errors: 1,
    write: loopRun(2),
  },
  {
    name: "ACCESS EXCLUSIVE mc.pins: archon-loop run INSERT that moves its version's first run",
    lock: exclusive('pins'),
    errors: 1,
    write: loopRun(3),
  },
];

class Release extends Error {}

/** Opens a transaction on `holder` that holds `sql`, and the function that rolls it back. */
async function holdLock(holder: Db, sql: string, runId: string): Promise<() => Promise<void>> {
  let release = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let held = () => {};
  let failed: (error: unknown) => void = () => {};
  const holding = new Promise<void>((resolve, reject) => {
    held = resolve;
    failed = reject;
  });
  const transaction = holder
    .transaction(async (tx) => {
      await tx.query(sql, sql.includes('$1') ? [runId] : undefined);
      held();
      await released;
      throw new Release();
    })
    .catch((error) => {
      if (!(error instanceof Release)) failed(error);
    });
  await holding;
  return async () => {
    release();
    await transaction;
  };
}

/**
 * The version cases' digest after them, as problems: one row for the unlocked case's run, since
 * every locked case lost its version write; the repair the digest's next write or `reconcile:laps`
 * applies; and a pin written after the run labelling it.
 */
async function versionProblems(db: Db, factory: string, runId: string): Promise<string[]> {
  const digest = loopDigest(runId);
  const problems: string[] = [];
  const [unrepaired] = await db.query(
    `SELECT count(*)::int AS n, bool_and(v.first_run_at = (SELECT max(l.started_at) FROM mc.laps l
       WHERE l.digest = $1)) AS first_unlocked FROM mc.versions v WHERE v.digest = $1`,
    [digest],
  );
  if (unrepaired?.n !== 1 || unrepaired?.first_unlocked !== true)
    problems.push("expected one version row at the unlocked case's run");

  await db.query('SELECT mc.project_version($1, $2)', [factory, digest]);
  const repaired = `SELECT count(*)::int AS n, bool_and(v.first_run_at = (SELECT min(l.started_at)
       FROM mc.laps l WHERE l.digest = $1)) AS first_earliest,
     bool_and(v.pin_sha IS NOT DISTINCT FROM (SELECT p.sha FROM mc.pins p
       WHERE p.committed_at < v.first_run_at ORDER BY p.committed_at DESC, p.sha DESC LIMIT 1))
       AS labelled
     FROM mc.versions v WHERE v.digest = $1`;
  const [row] = await db.query(repaired, [digest]);
  if (row?.n !== 1 || row?.first_earliest !== true || row?.labelled !== true)
    problems.push("expected the repair to move the version to the earliest run and that run's pin");

  try {
    await db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO mc.pins (sha, archon_sha, reason, committed_at)
         SELECT $1, 'projection-locks', 'lock wait check', v.first_run_at - interval '1 millisecond'
         FROM mc.versions v WHERE v.digest = $1`,
        [digest],
      );
      const [late] = await tx.query('SELECT pin_sha FROM mc.versions WHERE digest = $1', [digest]);
      if (late?.pin_sha !== digest)
        problems.push('expected a pin written after the run to label it');
      throw new Release();
    });
  } catch (error) {
    if (!(error instanceof Release)) throw error;
  }
  return problems;
}

const LAP_LOCK = holdSql(rowLock('laps', 'status', 'run_id = $1'));

const finishRun = (tx: Tx, runId: string) =>
  tx.query(
    `UPDATE remote_agent_workflow_runs SET status = 'completed', completed_at = now()
     WHERE id = $1`,
    [runId],
  );

/**
 * A finish Archon writes while another session holds the run's lap row, as problems: the write
 * commits within `bound` ms and its projection gives up with one 55P03; `reconcile:laps` (issue
 * #152) leaves the lap while it is still locked, and once the lock is gone one run projects the
 * finish, so the lane ends finished.
 */
async function finishProblems(archon: Db, holder: Db, bound: number): Promise<string[]> {
  const [run] = await archon.query(
    `INSERT INTO remote_agent_workflow_runs (workflow_name, status, user_message, metadata)
     VALUES ($1, 'running', 'lock wait check', '{}'::jsonb) RETURNING id`,
    [WORKFLOW],
  );
  const runId = String(run?.id);
  const lap = async () =>
    (await archon.query('SELECT status, completed_at FROM mc.laps WHERE run_id = $1', [runId]))[0];
  const problems: string[] = [];
  const before = (await errorStates(archon)).length;
  const release = await holdLock(holder, LAP_LOCK, runId);
  try {
    const result = await archonWrite(archon, runId, finishRun);
    if (result.error) problems.push(`Archon's write failed: ${result.error}`);
    if (result.elapsed > bound) problems.push('over the bound');
    const added = (await errorStates(archon)).slice(before);
    if (added.length !== 1 || added[0] !== '55P03')
      problems.push('expected one 55P03 projection error');
    await reconcileLaps(archon);
    if ((await lap())?.status !== 'running')
      problems.push('expected the repair to leave the lap while it is locked');
  } finally {
    await release();
  }
  const { failed } = await reconcileLaps(archon);
  for (const { message } of failed.filter((run) => run.runId === runId))
    problems.push(`the repair failed: ${message}`);
  const finished = await lap();
  if (finished?.status !== 'completed' || finished?.completed_at === null)
    problems.push('expected one repair after the lock to leave the lane finished');
  return problems;
}

/**
 * A run Archon starts while another session holds mc.laps, as problems: the insert commits within
 * `bound` ms and its projection gives up with one 55P03, leaving no lap; `reconcile:laps` (issue
 * #269) leaves it while mc.laps is still locked, and once the lock is gone one run projects the
 * lap, running.
 */
async function startProblems(archon: Db, holder: Db, bound: number): Promise<string[]> {
  let runId = '';
  const start = async (tx: Tx) => {
    const [run] = await tx.query(
      `INSERT INTO remote_agent_workflow_runs (workflow_name, status, user_message, metadata)
       VALUES ($1, 'running', 'lock wait check', '{}'::jsonb) RETURNING id`,
      [WORKFLOW],
    );
    runId = String(run?.id);
  };
  const lap = async () =>
    (await archon.query('SELECT status FROM mc.laps WHERE run_id = $1', [runId]))[0];
  const problems: string[] = [];
  const before = (await errorStates(archon)).length;
  const release = await holdLock(holder, holdSql(exclusive('laps')), '');
  try {
    const result = await archonWrite(archon, '', start);
    if (result.error) problems.push(`Archon's write failed: ${result.error}`);
    if (result.elapsed > bound) problems.push('over the bound');
    const added = (await errorStates(archon)).slice(before);
    if (added.length !== 1 || added[0] !== '55P03')
      problems.push('expected one 55P03 projection error');
    await reconcileLaps(archon);
  } finally {
    await release();
  }
  if (await lap()) problems.push('expected no lap until the repair after the lock');
  const { failed } = await reconcileLaps(archon);
  for (const { message } of failed.filter((run) => run.runId === runId))
    problems.push(`the repair failed: ${message}`);
  if ((await lap())?.status !== 'running')
    problems.push('expected one repair after the lock to give the run its lane, running');
  return problems;
}

async function errorStates(db: Db): Promise<string[]> {
  return (await db.query('SELECT sqlstate FROM mc.projection_errors ORDER BY id')).map((row) =>
    String(row.sqlstate),
  );
}

/** Archon's write, in its own session, as `elapsed` ms and its error when it did not commit. */
async function archonWrite(
  archon: Db,
  runId: string,
  write: Case['write'],
): Promise<{ elapsed: number; error?: string }> {
  const start = performance.now();
  try {
    await archon.transaction(async (tx) => {
      await tx.query(`SET LOCAL statement_timeout = '${ARCHON_STATEMENT_TIMEOUT}'`);
      await write(tx, runId);
    });
    return { elapsed: performance.now() - start };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { elapsed: performance.now() - start, error: message };
  }
}

export const main: Main = async (argv, deps) => {
  const usage = noArguments(argv, USAGE, deps);
  if (usage !== undefined) return usage;
  return failing(deps, async () => {
    const url = await guardedDatabaseUrl(deps, 'check');
    const archon = deps.openDb(url);
    const holder = deps.openDb(url);
    try {
      const [factory] = await archon.query(`SELECT f.name ${FACTORY_CODEBASE}`);
      if (!factory)
        throw new Error(
          'the check branch has no factory codebase: create it with bun run fixture:branch',
        );
      const [run] = await archon.query(
        `INSERT INTO remote_agent_workflow_runs (workflow_name, status, user_message, metadata)
         VALUES ($1, 'running', 'lock wait check', '{}'::jsonb) RETURNING id`,
        [WORKFLOW],
      );
      const runId = String(run?.id);
      await holder.query('SELECT 1');
      // A warm-up write, so the unlocked case times the same round trips as the locked ones.
      await archonWrite(archon, runId, stepEvent('pick'));
      deps.out(
        `run ${runId}, bound: unlocked time + ${BOUND_MS} ms, Archon statement_timeout ${ARCHON_STATEMENT_TIMEOUT}`,
      );

      let unlocked = 0;
      let skipped = 0;
      const failures: string[] = [];
      for (const check of CASES) {
        if (check.needs) {
          const [found] = await archon.query('SELECT to_regclass($1) IS NOT NULL AS present', [
            `public.${check.needs}`,
          ]);
          if (found?.present !== true) {
            skipped++;
            deps.out(
              `SKIP | ${check.name} | public.${check.needs} is absent on this branch, so no projection trigger exists on that path`,
            );
            continue;
          }
        }
        const before = (await errorStates(archon)).length;
        const release = check.lock
          ? await holdLock(holder, holdSql(check.lock), runId)
          : async () => {};
        const result = await archonWrite(archon, runId, check.write);
        await release();
        const added = (await errorStates(archon)).slice(before);
        if (!check.lock) unlocked = result.elapsed;

        const problems: string[] = [];
        if (result.error) problems.push(`Archon's write failed: ${result.error}`);
        if (result.elapsed > unlocked + BOUND_MS) problems.push('over the bound');
        if (added.length !== check.errors)
          problems.push(`expected ${check.errors} projection error(s)`);
        if (added.some((state) => state !== '55P03'))
          problems.push('a projection error other than 55P03');
        const verdict = problems.length === 0 ? 'PASS' : `FAIL (${problems.join('; ')})`;
        if (problems.length > 0) failures.push(check.name);
        deps.out(
          `${verdict} | ${check.name} | ${result.error ? 'failed' : 'committed'} in ${result.elapsed.toFixed(0)} ms | projection_errors +${added.length}${added.length ? ` (${added.join(', ')})` : ''}`,
        );
      }
      const versionCheck = 'versions: one row per digest, repaired and labelled by a late pin';
      const problems = await versionProblems(archon, String(factory.name), runId);
      if (problems.length > 0) failures.push(versionCheck);
      deps.out(
        `${problems.length === 0 ? 'PASS' : `FAIL (${problems.join('; ')})`} | ${versionCheck}`,
      );
      // After the version check: its repair projects the version cases' runs again too.
      const finishCheck = 'finish while the lap row is locked: repaired once the lock is gone';
      const finish = await finishProblems(archon, holder, unlocked + BOUND_MS);
      if (finish.length > 0) failures.push(finishCheck);
      deps.out(`${finish.length === 0 ? 'PASS' : `FAIL (${finish.join('; ')})`} | ${finishCheck}`);
      const startCheck = 'start while mc.laps is locked: its lap repaired once the lock is gone';
      const started = await startProblems(archon, holder, unlocked + BOUND_MS);
      if (started.length > 0) failures.push(startCheck);
      deps.out(`${started.length === 0 ? 'PASS' : `FAIL (${started.join('; ')})`} | ${startCheck}`);
      const checks = CASES.length + 3 - skipped;
      if (failures.length > 0) throw new Error(`${failures.length} of ${checks} checks failed`);
      deps.out(`all ${checks} checks passed${skipped ? `, ${skipped} skipped` : ''}`);
    } finally {
      await Promise.all([archon.close(), holder.close()]);
    }
  });
};

if (import.meta.main) await runCli(main);
