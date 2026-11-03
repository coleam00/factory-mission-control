import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isCheckBranch } from '../scripts/lib/guard';

/** How long after its last refresh a lease keeps an old check branch from another checkout's `fixture:drop`. */
export const LEASE_MS = 60 * 60 * 1000;

/** How often `serve` refreshes its branch's lease: well inside `LEASE_MS`. */
export const LEASE_REFRESH_MS = 10 * 60 * 1000;

/** Shared by every checkout on this machine, so one checkout's drop sees another's leases. */
export function defaultLeaseDir(): string {
  return join(homedir(), '.mc-check-leases');
}

/** A checkout's claim that it still uses `branch`, as of `refreshed_at`: the lease file's mtime. */
export type Lease = { branch: string; refreshed_at: string };

function leaseFile(dir: string, branch: string): string {
  return join(dir, `${branch}.lease`);
}

/** Records `branch` as in use at `at`; false when it is not a check branch or the write failed. */
export function writeLease(dir: string, branch: string, at: Date): boolean {
  if (!isCheckBranch(branch)) return false;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(leaseFile(dir, branch), '');
    utimesSync(leaseFile(dir, branch), at, at);
    return true;
  } catch {
    return false;
  }
}

/**
 * Moves an existing lease to `at`; never creates one, so only `fixture:branch` claims a branch.
 * False only when a lease exists and could not be moved.
 */
export function refreshLease(dir: string, branch: string, at: Date): boolean {
  const file = leaseFile(dir, branch);
  const lease = existsSync(file) && statSync(file, { throwIfNoEntry: false });
  return !lease || (lease.isFile() && writeLease(dir, branch, at));
}

/**
 * Refreshes `branch`'s lease now and every `LEASE_REFRESH_MS` through `every`, warning once if a
 * refresh fails. Does nothing without a branch.
 */
export function startLeaseRefresh(
  branch: string | undefined,
  dir: string,
  now: () => Date,
  every: (refresh: () => void, ms: number) => unknown,
  warn: (message: string) => void,
): void {
  if (!branch) return;
  let warned = false;
  const refresh = () => {
    if (refreshLease(dir, branch, now()) || warned) return;
    warned = true;
    warn(`could not refresh the lease for ${branch} in ${dir}`);
  };
  refresh();
  every(refresh, LEASE_REFRESH_MS);
}

/**
 * Every lease on a check branch in `dir`. A missing directory holds none; any other failure to
 * read it throws, so a drop never mistakes leases it cannot see for none.
 */
export function readLeases(dir: string): Lease[] {
  try {
    const leases: Lease[] = [];
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.lease')) continue;
      const branch = name.slice(0, -'.lease'.length);
      if (!isCheckBranch(branch)) continue;
      const lease = statSync(join(dir, name), { throwIfNoEntry: false });
      if (lease?.isFile()) leases.push({ branch, refreshed_at: lease.mtime.toISOString() });
    }
    return leases;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new Error(
      `cannot read the leases in ${dir}: ${error instanceof Error ? error.message : error}`,
    );
  }
}

/** Best effort, like every lease write: a lease left behind protects nothing once its branch is gone. */
export function removeLease(dir: string, branch: string): void {
  try {
    rmSync(leaseFile(dir, branch), { force: true });
  } catch {}
}

/** True while `at` is no more than `LEASE_MS` after the lease's last refresh. */
export function isLeaseLive(lease: Lease, at: Date): boolean {
  return at.getTime() - Date.parse(lease.refreshed_at) <= LEASE_MS;
}
