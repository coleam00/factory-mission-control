import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { CHECK_ENV_FILE, loadCheckEnv } from '../../server/check-env';
import { failing, type Main, runCli } from '../lib/cli';
import { isCheckBranch, requireCheckBranch } from '../lib/guard';
import { type Branch, waitForOperations } from '../lib/neon';

const STALE_MS = 3 * 60 * 60 * 1000;

/** This checkout's branch, and every `check-*` branch older than three hours. */
export function branchesToDrop(branches: Branch[], own: string | undefined, now: Date): Branch[] {
  if (own !== undefined) requireCheckBranch(own);
  return branches.filter(
    (branch) =>
      branch.name === own ||
      (isCheckBranch(branch.name) && now.getTime() - Date.parse(branch.created_at) > STALE_MS),
  );
}

export const main: Main = async (_argv, deps) =>
  failing(deps, async () => {
    loadCheckEnv(deps.repoRoot, deps.env);
    const own = deps.env.MC_CHECK_BRANCH;
    if (own !== undefined) requireCheckBranch(own);
    const api = deps.neon();
    for (const branch of branchesToDrop(await api.listBranches(), own, deps.now())) {
      await waitForOperations(api, await api.deleteBranch(branch), deps.sleep);
      deps.out(`deleted ${branch.name}`);
    }
    if (own !== undefined) rmSync(join(deps.repoRoot, CHECK_ENV_FILE), { force: true });
  });

if (import.meta.main) await runCli(main);
