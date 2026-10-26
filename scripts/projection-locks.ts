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
      'projection_errors',
    ),
    errors: 0,
    write: providerEvent,
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
      if (failures.length > 0)
        throw new Error(`${failures.length} of ${CASES.length} cases failed`);
      deps.out(`all ${CASES.length} cases passed`);
    } finally {
      await Promise.all([archon.close(), holder.close()]);
    }
  });
};

if (import.meta.main) await runCli(main);
