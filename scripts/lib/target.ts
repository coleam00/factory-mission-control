import type { NeonApi } from './neon';

/** The Neon endpoint id in a connection string's host, or null when it is not a Neon host. */
export function endpointIdOf(databaseUrl: string): string | null {
  let host: string;
  try {
    host = new URL(databaseUrl).hostname;
  } catch {
    return null;
  }
  if (!host.endsWith('.neon.tech')) return null;
  const id = host.split('.')[0].replace(/-pooler$/, '');
  return /^ep-[a-z0-9-]+$/.test(id) ? id : null;
}

/**
 * The name of the branch a connection string points at, asked of the Neon API (read-only), so a
 * branch name written beside the URL can never vouch for it.
 */
export async function resolveBranchName(databaseUrl: string, api: NeonApi): Promise<string> {
  const endpointId = endpointIdOf(databaseUrl);
  if (!endpointId) throw new Error('MC_DATABASE_URL is not a Neon endpoint in this project');
  const endpoint = await api.getEndpoint(endpointId);
  return (await api.getBranch(endpoint.branch_id)).name;
}
