import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { CHECK_ENV_FILE, loadCheckEnv } from '../../server/check-env';
import {
  defaultLeaseDir,
  isLeaseLive,
  type Lease,
  readLeases,
  removeLease,
} from '../../server/check-lease';
import type { RunStatus } from '../lib/archon-run';
import { type Deps, failing, type Main, noArguments, runCli } from '../lib/cli';
import { isCheckBranch, requireCheckBranch } from '../lib/guard';
import { type Branch, waitForOperations } from '../lib/neon';

const STALE_MS = 3 * 60 * 60 * 1000;

const USAGE = [
  `usage: bun run fixture:drop (deletes this checkout's check branch, the <branch>-stale-* branches \`fixture:branch --stale\` made for it, and every check-* branch older than 3 hours unless the run or checkout that owns it still uses it; other sessions' younger check-* branches are kept. Ownership is a lease in ${defaultLeaseDir()}: fixture:branch records it, naming the Archon run it runs in (WORKFLOW_ID) when there is one, and every command that uses the branch and \`serve\` while it runs refresh it. An old branch is kept while its lease was refreshed less than an hour ago, or while the run its lease names is pending, running or paused, however long that run goes without touching the branch; drop asks Archon, read-only, with \`ARCHON_CLI_COMMAND workflow get <run> --json\`, and keeps the branch, with a warning, when it cannot ask. A lease is seen only by checkouts on this machine; an old branch with no lease, or whose lease is over an hour old and names no run or a run that has completed, failed, been cancelled or is unknown to Archon, is deleted with its lease)`,
  '       bun run fixture:drop --dry-run (prints `would delete <name>` for each branch fixture:drop would delete, and deletes nothing; an unattended check runs it to observe the selection live while its own branch keeps serving)',
  `       bun run fixture:drop --dry-run --at <time> (prints what fixture:drop would delete if run at <time>, an ISO-8601 time with Z or an offset, not before now, and deletes nothing; only age is judged at <time>: a lease and its run are judged now, so a branch whose lease is live now, or whose run is still running now, is not listed at any <time>, and one with no lease, or one last refreshed over an hour ago whose run has ended or that names none, is listed once it is over 3 hours old at <time>; an unattended check proves age cleanup without waiting 3 hours: it reads the created_at of a young check-* branch it created that has no live lease (for example, one it made ownerless by removing its lease) and sees that branch listed at created_at + 3h + 1m and not at created_at + 3h - 1m (this checkout's own branch and its -stale- markers are listed at any time). Only --dry-run takes --at: a real drop always uses the real clock)`,
].join('\n');

/** An ISO-8601 date and time with an explicit zone, so `--at` names the same moment on every machine. */
export const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

/** The names `fixture:branch --stale` gives the branches it makes for this checkout. */
export function staleBranchPrefix(own: string): string {
  return `${own}-stale-`;
}

/**
 * This checkout's branch, the stale markers it made, and every `check-*` branch older than three
 * hours as of `at` whose lease is not live `now` and does not name a run in `liveRuns`. A lease and
 * its run are judged on the real clock only: its owner may refresh it again before `at`, so a
 * later `at` never makes it expire.
 */
export function branchesToDrop(
  branches: Branch[],
  own: string | undefined,
  at: Date,
  leases: Lease[],
  now: Date = at,
  liveRuns: ReadonlySet<string> = new Set(),
): Branch[] {
  if (own !== undefined) requireCheckBranch(own);
  const leased = (name: string) =>
    leases.some(
      (lease) =>
        lease.branch === name &&
        (isLeaseLive(lease, now) || (lease.run !== undefined && liveRuns.has(lease.run))),
    );
  return branches.filter(
    (branch) =>
      branch.name === own ||
      (own !== undefined &&
        isCheckBranch(branch.name) &&
        branch.name.startsWith(staleBranchPrefix(own))) ||
      (isCheckBranch(branch.name) &&
        at.getTime() - Date.parse(branch.created_at) > STALE_MS &&
        !leased(branch.name)),
  );
}

/**
 * The runs owning a candidate's lease that are still active, or that Archon cannot say have ended:
 * deleting on doubt could delete a running lap's database. This checkout's own branch and its stale
 * markers go whatever their lease says, so their runs are not asked about.
 */
async function runsStillUsing(
  candidates: Branch[],
  own: string | undefined,
  leases: Lease[],
  deps: Deps,
): Promise<Set<string>> {
  const asked = new Map<string, RunStatus>();
  const live = new Set<string>();
  for (const branch of candidates) {
    if (
      own !== undefined &&
      (branch.name === own || branch.name.startsWith(staleBranchPrefix(own)))
    )
      continue;
    const run = leases.find((lease) => lease.branch === branch.name)?.run;
    if (run === undefined) continue;
    let status = asked.get(run);
    if (!status) {
      status = await deps.runStatus(run);
      asked.set(run, status);
    }
    if (status.state === 'active') live.add(run);
    if (status.state === 'unknown') {
      live.add(run);
      deps.err(
        `kept ${branch.name}: cannot tell whether run ${run} that owns it is still running (${status.reason})`,
      );
    }
  }
  return live;
}

async function drop(deps: Deps, dryRun: boolean, at?: Date): Promise<void> {
  loadCheckEnv(deps.repoRoot, deps.env);
  const own = deps.env.MC_CHECK_BRANCH;
  if (own !== undefined) requireCheckBranch(own);
  const leases = readLeases(deps.leaseDir);
  const api = deps.neon();
  const branches = await api.listBranches();
  const now = deps.now();
  const when = at ?? now;
  const liveRuns = await runsStillUsing(
    branchesToDrop(branches, own, when, leases, now),
    own,
    leases,
    deps,
  );
  const selected = branchesToDrop(branches, own, when, leases, now, liveRuns);
  if (dryRun) {
    for (const branch of selected) deps.out(`would delete ${branch.name}`);
    return;
  }
  const failed: string[] = [];
  for (const branch of selected) {
    try {
      await waitForOperations(api, await api.deleteBranch(branch), deps.sleep);
      removeLease(deps.leaseDir, branch.name);
      deps.out(`deleted ${branch.name}`);
    } catch (error) {
      deps.err(
        `could not delete ${branch.name}: ${error instanceof Error ? error.message : error}`,
      );
      failed.push(branch.name);
    }
  }
  if (own !== undefined && !failed.includes(own)) {
    rmSync(join(deps.repoRoot, CHECK_ENV_FILE), { force: true });
  }
  if (failed.length > 0) throw new Error(`fixture:drop left ${failed.join(', ')}`);
}

/** The moment `--dry-run --at <time>` (either order) names, or why `argv` is not that. */
function dryRunAt(argv: string[], deps: Deps): Date | string {
  const flag = argv.indexOf('--at');
  const rest = argv.filter((_, index) => index !== flag && index !== flag + 1);
  // An unknown flag is the real problem whatever else is given, so it is named first (#71).
  const unknown = rest.find((arg) => arg.startsWith('-') && arg !== '--dry-run' && arg !== '--at');
  if (unknown !== undefined) return `unknown argument ${unknown}`;
  if (rest.length !== 1 || rest[0] !== '--dry-run') return '--at is only taken with --dry-run';
  const value = argv[flag + 1];
  if (value === undefined) return '--at needs a time';
  if (!ISO_TIME.test(value) || Number.isNaN(Date.parse(value))) {
    return `--at ${value} is not an ISO-8601 time with a zone`;
  }
  const at = new Date(value);
  if (at.getTime() < deps.now().getTime()) return `--at ${value} is before now`;
  return at;
}

export const main: Main = async (argv, deps) => {
  if (argv.length === 1 && argv[0] === '--dry-run') return failing(deps, () => drop(deps, true));
  if (argv.includes('--at')) {
    const at = dryRunAt(argv, deps);
    if (typeof at === 'string') {
      deps.err(`${at}\n${USAGE}`);
      return 2;
    }
    return failing(deps, () => drop(deps, true, at));
  }
  return noArguments(argv, USAGE, deps, ['--dry-run']) ?? failing(deps, () => drop(deps, false));
};

if (import.meta.main) await runCli(main);
