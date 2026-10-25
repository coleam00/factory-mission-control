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
].join('\n');

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

async function drop(deps: Deps, dryRun: boolean): Promise<void> {
  loadCheckEnv(deps.repoRoot, deps.env);
  const own = deps.env.MC_CHECK_BRANCH;
  if (own !== undefined) requireCheckBranch(own);
  const api = deps.neon();
  const selected = branchesToDrop(await api.listBranches(), own, deps.now());
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

export const main: Main = async (argv, deps) => {
  if (argv.length === 1 && argv[0] === '--dry-run') return failing(deps, () => drop(deps, true));
  return noArguments(argv, USAGE, deps) ?? failing(deps, () => drop(deps, false));
};

if (import.meta.main) await runCli(main);
