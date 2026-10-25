import type { GetFetch } from '../../function/github';

// Reads a directory of a public repository at one commit. Every request is a GET by type
// (invariant 2: read-only toward GitHub and the factories). The API finds the directory's tree;
// the files come from raw.githubusercontent.com, which the API's rate limit does not count.

const API = 'https://api.github.com';
const RAW = 'https://raw.githubusercontent.com';

const HEADERS = {
  accept: 'application/vnd.github+json',
  'user-agent': 'factory-mission-control',
  'x-github-api-version': '2022-11-28',
};

interface TreeEntry {
  path: string;
  type: 'blob' | 'tree' | 'commit';
  sha: string;
}

export interface RemoteFile {
  /** Relative to the directory asked for, `/`-separated. */
  path: string;
  bytes: Uint8Array;
}

export interface RemoteDirectory {
  /** The full commit sha `ref` resolved to. */
  sha: string;
  files: RemoteFile[];
}

const encodePath = (path: string) => path.split('/').map(encodeURIComponent).join('/');

export async function readDirectoryAt(
  fetch: GetFetch,
  repository: string,
  ref: string,
  dir: string,
): Promise<RemoteDirectory> {
  async function get(url: string): Promise<Response> {
    const response = await fetch(url, { method: 'GET', headers: HEADERS });
    if (!response.ok) throw new Error(`GET ${url} failed: ${response.status}`);
    return response;
  }
  const api = async <T>(path: string): Promise<T> =>
    (await (await get(`${API}/repos/${repository}${path}`)).json()) as T;

  const commit = await api<{ sha: string; commit: { tree: { sha: string } } }>(
    `/commits/${encodeURIComponent(ref)}`,
  );
  let treeSha = commit.commit.tree.sha;
  for (const name of dir.split('/')) {
    const { tree } = await api<{ tree: TreeEntry[] }>(`/git/trees/${treeSha}`);
    const entry = tree.find((e) => e.path === name && e.type === 'tree');
    if (!entry) throw new Error(`${repository} has no ${dir}/ at ${commit.sha}`);
    treeSha = entry.sha;
  }
  const listing = await api<{ tree: TreeEntry[]; truncated: boolean }>(
    `/git/trees/${treeSha}?recursive=1`,
  );
  if (listing.truncated) throw new Error(`${repository} lists ${dir}/ truncated at ${commit.sha}`);

  const files: RemoteFile[] = [];
  for (const { path } of listing.tree.filter((e) => e.type === 'blob')) {
    const response = await get(
      `${RAW}/${repository}/${commit.sha}/${encodePath(`${dir}/${path}`)}`,
    );
    files.push({ path, bytes: new Uint8Array(await response.arrayBuffer()) });
  }
  return { sha: commit.sha, files };
}
