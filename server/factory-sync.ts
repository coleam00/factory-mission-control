import type { OpenDb } from '../scripts/lib/db';
import { isCheckBranch, requireCheckBranch } from '../scripts/lib/guard';
import { loadFactories } from '../scripts/lib/load-factories';
import type { NeonApi } from '../scripts/lib/neon';
import { resolveBranchName } from '../scripts/lib/target';
import type { Env } from './check-env';
import { readFactories } from './factories';

export type SyncDeps = {
  env: Env;
  repoRoot: string;
  neon: (keys: { apiKey: string; projectId: string }) => NeonApi;
  openDb: OpenDb;
};

/**
 * Before the first request, loads the factories file the server serves into mc.factories, as
 * `migrate -- --configured-factories` does, when MC_DATABASE_URL is on a check-* branch. Main and
 * rewind-* branches are never read or written; neither is a branch the Neon API cannot name, so a
 * server whose branch is unknown starts as it did before. Returns the line to print, if any, and
 * rejects when the sync on a check-* branch fails, so the server does not serve stale rows.
 */
export async function syncFactoriesAtStart(deps: SyncDeps): Promise<string | undefined> {
  const url = deps.env.MC_DATABASE_URL;
  if (!url) return undefined;
  const { NEON_API_KEY: apiKey, NEON_PROJECT_ID: projectId } = deps.env;
  if (!apiKey || !projectId) {
    return 'factories not synced: NEON_API_KEY and NEON_PROJECT_ID are needed to tell a check-* branch';
  }
  let name: string;
  try {
    name = await resolveBranchName(url, deps.neon({ apiKey, projectId }));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return `factories not synced: could not tell the branch (${reason})`;
  }
  if (!isCheckBranch(name)) {
    return `factories not synced: serve writes only check-* branches, not ${name}`;
  }
  requireCheckBranch(name);
  const entries = readFactories(deps.env, deps.repoRoot);
  const db = deps.openDb(url);
  try {
    const changed = await loadFactories({ entries, db });
    return `factories synced on ${name}: ${changed.factories} factory row(s) written, ${changed.laps} lap(s) re-attributed`;
  } finally {
    await db.close();
  }
}
