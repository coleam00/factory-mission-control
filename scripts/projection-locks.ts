import { eventData } from './fixture/write';
import { failing, guardedDatabaseUrl, type Main, noArguments, runCli } from './lib/cli';
import type { Db, Tx } from './lib/db';

const USAGE = 'usage: bun run projection:locks (the check branch in .mc-check.env)';

/**
 * How much longer than the unlocked write a locked one may take: the projection's own wait and
 * its error record's, 100 ms each (0006_projection.sql), with room for the network.
 */
export const BOUND_MS = 400;

/** Archon's write gets a statement timeout, so a wait the projection does not stop ends as a failure. */
const ARCHON_STATEMENT_TIMEOUT = '5s';

type Case = {
  name: string;
  /** What a second session holds, in an open transaction, while Archon writes. */
  hold?: string;
  /** The projection errors Archon's write should leave: one when the projection gave up. */
  errors: number;
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
     SELECT 'archon-loop', c.id, 'completed', 'lock wait check',
       jsonb_build_object('workflow_source', jsonb_build_object('digest', $1::text)),
       now() - make_interval(days => $2::int)
     ${FACTORY_CODEBASE}`,
    [loopDigest(runId), daysBefore],
  );

const exclusive = (...tables: string[]) =>
  `LOCK TABLE ${tables.map((table) => `mc.${table}`).join(', ')} IN ACCESS EXCLUSIVE MODE`;

export const CASES: Case[] = [
  { name: 'no lock: node_completed', errors: 0, write: stepEvent('pick') },
  {
    name: 'ACCESS EXCLUSIVE mc.lap_steps: node_completed',
    hold: exclusive('lap_steps'),
    errors: 1,
    write: stepEvent('pick'),
  },
  {
    name: 'uncommitted UPDATE of the same mc.lap_steps row: node_completed',
    hold: `UPDATE mc.lap_steps SET error = error WHERE run_id = $1 AND step_id = 'pick'`,
    errors: 1,
    write: stepEvent('pick'),
  },
  {
    name: 'ACCESS EXCLUSIVE mc.lap_step_attempts: node_completed',
    hold: exclusive('lap_step_attempts'),
    errors: 1,
    write: stepEvent('pick'),
  },
  {
    name: 'ACCESS EXCLUSIVE mc.app_check_lines: check-app node_completed',
    hold: exclusive('app_check_lines'),
    errors: 1,
    write: stepEvent('check-app'),
  },
  {
    name: 'ACCESS EXCLUSIVE mc.laps: run status UPDATE',
    hold: exclusive('laps'),
    errors: 1,
    write: newStatus,
  },
  {
    name: 'uncommitted UPDATE of the same mc.laps row: run status UPDATE',
    hold: 'UPDATE mc.laps SET status = status WHERE run_id = $1',
    errors: 1,
    write: newStatus,
  },
  {
    name: 'ACCESS EXCLUSIVE mc.factories: run INSERT',
    hold: exclusive('factories'),
    errors: 1,
    write: newRun,
  },
  {
    name: 'ACCESS EXCLUSIVE mc.lap_steps and mc.projection_errors: node_completed',
    hold: exclusive('lap_steps', 'projection_errors'),
    errors: 0,
    write: stepEvent('pick'),
  },
  {
    name: 'ACCESS EXCLUSIVE on every mc table the projection writes: provider_event',
    hold: exclusive(
      'laps',
      'lap_steps',
      'lap_step_attempts',
      'app_check_lines',
      'factories',
      'versions',
      'pins',
      'projection_errors',
    ),
    errors: 0,
    write: providerEvent,
  },
  { name: 'no lock: archon-loop run INSERT with a new digest', errors: 0, write: loopRun(0) },
  {
    name: "ACCESS EXCLUSIVE mc.versions: archon-loop run INSERT that moves its version's first run",
    hold: exclusive('versions'),
    errors: 1,
    write: loopRun(1),
  },
  {
    name: "uncommitted UPDATE of the same mc.versions row: archon-loop run INSERT that moves its version's first run",
    hold: `UPDATE mc.versions SET pin_sha = pin_sha WHERE digest = 'projection-locks:' || $1::text`,
    errors: 1,
    write: loopRun(2),
  },
  {
    name: "ACCESS EXCLUSIVE mc.pins: archon-loop run INSERT that moves its version's first run",
    hold: exclusive('pins'),
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
       WHERE p.factory = v.factory AND p.committed_at < v.first_run_at ORDER BY p.committed_at DESC, p.sha DESC LIMIT 1))
       AS labelled
     FROM mc.versions v WHERE v.digest = $1`;
  const [row] = await db.query(repaired, [digest]);
  if (row?.n !== 1 || row?.first_earliest !== true || row?.labelled !== true)
    problems.push("expected the repair to move the version to the earliest run and that run's pin");

  try {
    await db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO mc.pins (sha, archon_sha, reason, committed_at, factory)
         SELECT $1, 'projection-locks', 'lock wait check', v.first_run_at - interval '1 millisecond',
           v.factory
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
         VALUES ('projection-locks', 'running', 'lock wait check', '{}'::jsonb) RETURNING id`,
      );
      const runId = String(run?.id);
      await holder.query('SELECT 1');
      // A warm-up write, so the unlocked case times the same round trips as the locked ones.
      await archonWrite(archon, runId, stepEvent('pick'));
      deps.out(
        `run ${runId}, bound: unlocked time + ${BOUND_MS} ms, Archon statement_timeout ${ARCHON_STATEMENT_TIMEOUT}`,
      );

      let unlocked = 0;
      const failures: string[] = [];
      for (const check of CASES) {
        const before = (await errorStates(archon)).length;
        const release = check.hold ? await holdLock(holder, check.hold, runId) : async () => {};
        const result = await archonWrite(archon, runId, check.write);
        await release();
        const added = (await errorStates(archon)).slice(before);
        if (!check.hold) unlocked = result.elapsed;

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
      const checks = CASES.length + 1;
      if (failures.length > 0) throw new Error(`${failures.length} of ${checks} checks failed`);
      deps.out(`all ${checks} checks passed`);
    } finally {
      await Promise.all([archon.close(), holder.close()]);
    }
  });
};

if (import.meta.main) await runCli(main);
