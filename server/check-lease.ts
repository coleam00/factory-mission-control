import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

/** A checkout's claim that it still uses `branch`, as of `refreshed_at`. */
export type Lease = { branch: string; refreshed_at: string };

function leaseFile(dir: string, branch: string): string {
  return join(dir, `${branch}.json`);
}

/** Records `branch` as in use at `at`; false when it is not a check branch or the write failed. */
export function writeLease(dir: string, branch: string, at: Date): boolean {
  if (!isCheckBranch(branch)) return false;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(leaseFile(dir, branch), JSON.stringify({ refreshed_at: at.toISOString() }));
    return true;
  } catch {
    return false;
  }
}

/** Moves an existing lease to `at`; never creates one, so only `fixture:branch` claims a branch. */
export function refreshLease(dir: string, branch: string, at: Date): void {
  if (existsSync(leaseFile(dir, branch))) writeLease(dir, branch, at);
}

/** Every readable lease on a check branch in `dir`; a missing directory or a malformed file is no lease. */
export function readLeases(dir: string): Lease[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const leases: Lease[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const branch = name.slice(0, -'.json'.length);
    if (!isCheckBranch(branch)) continue;
    try {
      const refreshed = JSON.parse(readFileSync(join(dir, name), 'utf-8'))?.refreshed_at;
      if (typeof refreshed === 'string' && !Number.isNaN(Date.parse(refreshed))) {
        leases.push({ branch, refreshed_at: refreshed });
      }
    } catch {}
  }
  return leases;
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
