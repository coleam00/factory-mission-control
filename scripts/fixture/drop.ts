import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { CHECK_ENV_FILE, loadCheckEnv } from '../../server/check-env';
import { type Deps, failing, type Main, noArguments, runCli } from '../lib/cli';
import { isCheckBranch, requireCheckBranch } from '../lib/guard';
import { type Branch, waitForOperations } from '../lib/neon';

const STALE_MS = 3 * 60 * 60 * 1000;

const USAGE = [
  "usage: bun run fixture:drop (deletes this checkout's check branch, the <branch>-stale-* branches `fixture:branch --stale` made for it, and every check-* branch older than 3 hours; other sessions' younger check-* branches are kept)",
  '       bun run fixture:drop --dry-run (prints `would delete <name>` for each branch fixture:drop would delete, and deletes nothing; an unattended check runs it to observe the selection live while its own branch keeps serving)',
  "       bun run fixture:drop --dry-run --at <time> (prints what fixture:drop would delete if run at <time>, an ISO-8601 time with Z or an offset, not before now, and deletes nothing; an unattended check proves age cleanup without waiting 3 hours: it reads the created_at of a young check-* branch it created and sees that branch listed at created_at + 3h + 1m and not at created_at + 3h - 1m (this checkout's own branch and its -stale- markers are listed at any time). Only --dry-run takes --at: a real drop always uses the real clock)",
].join('\n');

/** An ISO-8601 date and time with an explicit zone, so `--at` names the same moment on every machine. */
export const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

/** The names `fixture:branch --stale` gives the branches it makes for this checkout. */
export function staleBranchPrefix(own: string): string {
  return `${own}-stale-`;
}

/** This checkout's branch, the stale markers it made, and every `check-*` branch older than three hours. */
export function branchesToDrop(branches: Branch[], own: string | undefined, now: Date): Branch[] {
  if (own !== undefined) requireCheckBranch(own);
  return branches.filter(
    (branch) =>
      branch.name === own ||
      (own !== undefined &&
        isCheckBranch(branch.name) &&
        branch.name.startsWith(staleBranchPrefix(own))) ||
      (isCheckBranch(branch.name) && now.getTime() - Date.parse(branch.created_at) > STALE_MS),
  );
}

async function drop(deps: Deps, dryRun: boolean, at?: Date): Promise<void> {
  loadCheckEnv(deps.repoRoot, deps.env);
  const own = deps.env.MC_CHECK_BRANCH;
  if (own !== undefined) requireCheckBranch(own);
  const api = deps.neon();
  const selected = branchesToDrop(await api.listBranches(), own, at ?? deps.now());
  if (dryRun) {
    for (const branch of selected) deps.out(`would delete ${branch.name}`);
    return;
  }
  const failed: string[] = [];
  for (const branch of selected) {
    try {
      await waitForOperations(api, await api.deleteBranch(branch), deps.sleep);
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
