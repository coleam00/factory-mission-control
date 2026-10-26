import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Deps } from './cli';

/** Where `test:live` holds its lock: the user's temp directory, shared by every checkout. */
export function machineLockPath(deps: Deps): string {
  return deps.env.MC_TEST_LIVE_LOCK ?? join(tmpdir(), 'factory-mission-control-test-live.lock');
}

export const LOCK_WAIT_MS = 30 * 60_000;
export const LOCK_POLL_MS = 2_000;

type Holder = { pid: number; since: string };

/** True while a process with `pid` exists; EPERM means it exists but is not ours to signal. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The lock's holder, undefined when there is no lock, null when the file names no process. */
function readHolder(path: string): Holder | null | undefined {
  let text: string;
  try {
    text = readFileSync(path, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    const holder = JSON.parse(text);
    return Number.isInteger(holder?.pid) && holder.pid > 0 ? holder : null;
  } catch {
    return null;
  }
}

function tryCreate(path: string, holder: Holder): boolean {
  try {
    writeFileSync(path, `${JSON.stringify(holder)}\n`, { flag: 'wx' });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
}

export type MachineLock = { path: string; release: () => void };

/**
 * Takes the machine-wide lock at `path` for this process, waiting up to `waitMs` for a live
 * holder to let go and taking over a lock whose process no longer exists. Throws, naming the
 * holder, when the wait runs out.
 */
export async function acquireMachineLock(
  deps: Deps,
  path: string,
  options: {
    pid?: number;
    waitMs?: number;
    pollMs?: number;
    alive?: (pid: number) => boolean;
  } = {},
): Promise<MachineLock> {
  const pid = options.pid ?? process.pid;
  const waitMs = options.waitMs ?? LOCK_WAIT_MS;
  const pollMs = options.pollMs ?? LOCK_POLL_MS;
  const alive = options.alive ?? processAlive;
  const started = deps.now().getTime();
  let waitingOn: number | undefined;
  let unreadable = false;
  for (;;) {
    if (tryCreate(path, { pid, since: deps.now().toISOString() })) break;
    const holder = readHolder(path);
    if (holder === undefined) continue;
    if (holder === null) {
      // Another run may be between creating the file and writing it; one poll later, a file that
      // still names no process was cut short by a crash.
      if (unreadable) {
        deps.out(`test:live lock ${path} names no process: taking it over`);
        rmSync(path, { force: true });
        unreadable = false;
        continue;
      }
      unreadable = true;
      await deps.sleep(pollMs);
      continue;
    }
    unreadable = false;
    if (holder.pid === pid) break;
    if (!alive(holder.pid)) {
      deps.out(
        `test:live lock ${path} was left by process ${holder.pid}, which no longer exists: taking it over`,
      );
      rmSync(path, { force: true });
      continue;
    }
    const waited = deps.now().getTime() - started;
    if (waited >= waitMs) {
      throw new Error(
        `test:live lock ${path} is still held by process ${holder.pid} after ${Math.round(waited / 60_000)} min: another test:live is running on this machine`,
      );
    }
    if (waitingOn !== holder.pid) {
      deps.out(
        `waiting for test:live lock ${path}, held by process ${holder.pid} (up to ${Math.round(waitMs / 60_000)} min)`,
      );
      waitingOn = holder.pid;
    }
    await deps.sleep(pollMs);
  }
  if (waitingOn !== undefined) deps.out(`took test:live lock ${path}`);
  return {
    path,
    release: () => {
      if (readHolder(path)?.pid === pid) rmSync(path, { force: true });
    },
  };
}

/**
 * Runs `work` holding the machine-wide lock, releasing it when `work` ends, throws, or the
 * process is stopped with Ctrl-C.
 */
export async function withMachineLock<T>(
  deps: Deps,
  path: string,
  work: () => Promise<T>,
  options: Parameters<typeof acquireMachineLock>[2] = {},
): Promise<T> {
  const lock = await acquireMachineLock(deps, path, options);
  const onExit = () => lock.release();
  const onSignal = (signal: NodeJS.Signals) => {
    lock.release();
    process.exit(signal === 'SIGINT' ? 130 : 143);
  };
  process.on('exit', onExit);
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    return await work();
  } finally {
    process.off('exit', onExit);
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    lock.release();
  }
}
