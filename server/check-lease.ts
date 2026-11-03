import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isCheckBranch } from '../scripts/lib/guard';

const LEASE_HOURS = 1;

/** How long after its last refresh a lease keeps an old check branch from another checkout's `fixture:drop`. */
export const LEASE_MS = LEASE_HOURS * 60 * 60 * 1000;

/** `LEASE_MS` in words, for help text. */
export const LEASE_LENGTH = LEASE_HOURS === 1 ? 'an hour' : `${LEASE_HOURS} hours`;

/** How often `serve` refreshes its branch's lease: well inside `LEASE_MS`. */
export const LEASE_REFRESH_MS = 10 * 60 * 1000;

/** Shared by every checkout on this machine, so one checkout's drop sees another's leases. */
export function defaultLeaseDir(): string {
  return join(homedir(), '.mc-check-leases');
}

/**
 * A checkout's claim that it still uses `branch`, as of `refreshed_at`. `null` is a lease file
 * that exists but cannot be read: it holds its branch at every moment, since deleting a branch a
 * run still uses cannot be undone and keeping one too long can.
 */
export type Lease = { branch: string; refreshed_at: string | null };

function leaseFile(dir: string, branch: string): string {
  return join(dir, `${branch}.json`);
}

/** Records `branch` as in use at `at`; false when it is not a check branch or the write failed. */
export function writeLease(dir: string, branch: string, at: Date): boolean {
  if (!isCheckBranch(branch)) return false;
  // Written aside and renamed in, so a concurrent drop never reads a half-written lease.
  const pending = `${leaseFile(dir, branch)}.${process.pid}.tmp`;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(pending, JSON.stringify({ refreshed_at: at.toISOString() }));
    renameSync(pending, leaseFile(dir, branch));
    return true;
  } catch {
    removeLeaseFile(pending);
    return false;
  }
}

/**
 * Moves an existing lease to `at`; never creates one, so only `fixture:branch` claims a branch.
 * False only when a lease exists and could not be moved.
 */
export function refreshLease(dir: string, branch: string, at: Date): boolean {
  return !existsSync(leaseFile(dir, branch)) || writeLease(dir, branch, at);
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
 * list it throws, so a drop never mistakes leases it cannot see for none.
 */
export function readLeases(dir: string): Lease[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new Error(
      `cannot read the leases in ${dir}: ${error instanceof Error ? error.message : error}`,
    );
  }
  const leases: Lease[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const branch = name.slice(0, -'.json'.length);
    if (isCheckBranch(branch)) leases.push({ branch, refreshed_at: refreshedAt(join(dir, name)) });
  }
  return leases;
}

function refreshedAt(file: string): string | null {
  try {
    const refreshed = JSON.parse(readFileSync(file, 'utf-8'))?.refreshed_at;
    return typeof refreshed === 'string' && !Number.isNaN(Date.parse(refreshed)) ? refreshed : null;
  } catch {
    return null;
  }
}

/** Best effort, like every lease write: a lease left behind protects nothing once its branch is gone. */
export function removeLease(dir: string, branch: string): void {
  removeLeaseFile(leaseFile(dir, branch));
}

function removeLeaseFile(file: string): void {
  try {
    rmSync(file, { force: true });
  } catch {}
}

/** True while `at` is no more than `LEASE_MS` after the lease's last refresh, and always for an unreadable lease. */
export function isLeaseLive(lease: Lease, at: Date): boolean {
  return lease.refreshed_at === null || at.getTime() - Date.parse(lease.refreshed_at) <= LEASE_MS;
}
