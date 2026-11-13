import type { Deps } from './cli';
import type { OpenDb } from './db';

/** A job's single-pass lock, held until `release`. */
export type PassLock = {
  /** Frees the lock; throws when its connection failed during the pass, since the guard was lost. */
  release(): Promise<void>;
};

/** Takes the lock for `job` on the database at `url`; undefined while another pass holds it. */
export type TakePassLock = (url: string, job: string) => Promise<PassLock | undefined>;

/** The first key of every pass lock, so no other app's advisory lock on the database collides. */
export const PASS_LOCK_NAMESPACE = 'factory-mission-control';

/**
 * A transaction-scoped Postgres advisory lock on a connection of its own, held open for the whole
 * pass. It lives in the database, so passes on other machines see it. It is transaction-scoped, not
 * session-scoped, so it stays on one server connection behind a transaction-mode pooler too. When
 * the process dies the socket closes, the server aborts the transaction and the lock is released.
 * It touches no table, so it cannot delay an Archon write.
 */
export function advisoryPassLock(open: OpenDb): TakePassLock {
  return async (url, job) => {
    const db = open(url);
    let answer!: (taken: boolean) => void;
    const answered = new Promise<boolean>((resolve) => {
      answer = resolve;
    });
    let letGo!: () => void;
    const released = new Promise<void>((resolve) => {
      letGo = resolve;
    });
    const transaction = db.transaction(async (tx) => {
      // The transaction sits idle for the whole pass; a server default must not end it early.
      await tx.query('SET LOCAL idle_in_transaction_session_timeout = 0', []);
      const [row] = await tx.query(
        'SELECT pg_try_advisory_xact_lock(hashtext($1), hashtext($2)) AS taken',
        [PASS_LOCK_NAMESPACE, job],
      );
      answer(row?.taken === true);
      await released;
    });
    // Handled at once, so a failure that arrives late is never an unhandled rejection.
    const ended = transaction.then(
      () => undefined,
      (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
    );
    const taken = await Promise.race([answered, ended.then(() => false)]);
    if (!taken) {
      letGo();
      const failure = await ended;
      await db.close();
      if (failure) throw failure;
      return undefined;
    }
    return {
      async release() {
        letGo();
        const failure = await ended;
        await db.close();
        if (failure) {
          throw new Error(
            `the ${job} pass lock's connection failed during the pass: ${failure.message}`,
          );
        }
      },
    };
  };
}

/** Runs `work` as the only pass of `job` on the database at `url`; a start that finds one running does nothing. */
export async function singlePass(
  deps: Deps,
  url: string,
  job: string,
  work: () => Promise<void>,
): Promise<void> {
  const lock = await deps.passLock(url, job);
  if (!lock) {
    // Exit 0: a timer tick that finds the last pass still running is the intended outcome, not a failure.
    deps.out(`${job}: another ${job} pass is running on this database, so this one did not start`);
    return;
  }
  try {
    await work();
  } catch (error) {
    await lock.release().catch((releaseError: unknown) => {
      deps.err(releaseError instanceof Error ? releaseError.message : String(releaseError));
    });
    throw error;
  }
  await lock.release();
}
