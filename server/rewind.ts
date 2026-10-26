import { requireRewindBranch } from '../scripts/lib/guard';
import type { NeonApi } from '../scripts/lib/neon';

export class UnknownRewindBranch extends Error {
  constructor(name: string) {
    super(`no branch named ${name}`);
    this.name = 'UnknownRewindBranch';
  }
}

/**
 * Where a rewind branch serves Realtime and the secret that seals for it, asked of the Neon API.
 * Refuses a name that is not `rewind-*` before any request; both values stay on the server.
 */
export async function rewindRealtime(
  api: NeonApi,
  name: string,
): Promise<{ host: string; secret: string }> {
  requireRewindBranch(name);
  const branch = (await api.listBranches()).find((b) => b.name === name);
  if (!branch) throw new UnknownRewindBranch(name);
  const [endpoint] = await api.branchEndpoints(branch.id);
  if (!endpoint) throw new Error(`${name} has no endpoint`);
  return { host: endpoint.host, secret: await api.getRealtimeSecret(branch.id) };
}
