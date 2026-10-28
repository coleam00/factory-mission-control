import { type OpenDb, openDb } from '../scripts/lib/db';
import { isRewindBranch, requireRewindBranch } from '../scripts/lib/guard';
import type { NeonApi } from '../scripts/lib/neon';

export class UnknownRewindBranch extends Error {
  constructor(name: string) {
    super(`no branch named ${name}`);
    this.name = 'UnknownRewindBranch';
  }
}

export class UnlistedRewindBranch extends Error {
  constructor(name: string) {
    super(`${name} is not in the rewind list`);
    this.name = 'UnlistedRewindBranch';
  }
}

/**
 * Whether `/rewind` lists the branch: a row of `mc.rewind_branches` on the server's home branch
 * at `url`. Connects only for the one query, so the server never holds the home compute awake.
 */
export function rewindListed(
  url: string,
  open: OpenDb = openDb,
): (name: string) => Promise<boolean> {
  return async (name) => {
    const db = open(url);
    try {
      const rows = await db.query('SELECT 1 FROM mc.rewind_branches WHERE name = $1', [name]);
      return rows.length > 0;
    } finally {
      await db.close();
    }
  };
}

/**
 * Where a rewind branch serves Realtime and the secret that seals for it, asked of the Neon API.
 * Refuses a name that is not `rewind-*`, or that `/rewind` does not list, before any request;
 * both values stay on the server.
 */
export async function rewindRealtime(
  api: NeonApi,
  name: string,
  listed: (name: string) => Promise<boolean>,
): Promise<{ host: string; secret: string }> {
  requireRewindBranch(name);
  if (!(await listed(name))) throw new UnlistedRewindBranch(name);
  const branch = (await api.listBranches()).find((b) => b.name === name);
  if (!branch) throw new UnknownRewindBranch(name);
  const [endpoint] = await api.branchEndpoints(branch.id);
  if (!endpoint) throw new Error(`${name} has no endpoint`);
  return { host: endpoint.host, secret: await api.getRealtimeSecret(branch.id) };
}

/** The names of the project's rewind-* branches that exist now, asked of the Neon API. */
export async function rewindBranchNames(api: NeonApi): Promise<string[]> {
  return (await api.listBranches()).map((b) => b.name).filter(isRewindBranch);
}
