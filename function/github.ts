// The only way the Function and the scripts reach GitHub. Requests are GETs by type, never anything
// else (invariant 2: read-only toward the factories).

export type GetFetch = (
  url: string,
  init: { method: 'GET'; headers: Record<string, string> },
) => Promise<Response>;

export interface GitHub {
  /** The file's text at `ref`, or null when the file does not exist there. */
  fileAt(repository: string, path: string, ref: string): Promise<string | null>;
  /** The JSON GitHub returns for `path` under the API root. */
  get<T>(path: string): Promise<T>;
  /** Every item of the list at `path`, following each page's `Link: rel="next"`. */
  list<T>(path: string): Promise<T[]>;
}

export const API_ROOT = 'https://api.github.com';

/** GitHub answered a GET with a status other than success (or, for `fileAt`, 404). */
export class GitHubError extends Error {
  constructor(
    readonly url: string,
    readonly status: number,
  ) {
    super(`GET ${url} failed: ${status}`);
  }
}

const NEXT_PAGE = /<([^>]+)>;\s*rel="next"/;

/** `token`, when given, only raises the rate limit; every repository read here is public. */
export function createGitHub(fetch: GetFetch = globalThis.fetch, token?: string): GitHub {
  async function request(url: string, accept: string): Promise<Response> {
    const headers: Record<string, string> = {
      accept,
      'user-agent': 'factory-mission-control',
      'x-github-api-version': '2022-11-28',
    };
    if (token) headers.authorization = `Bearer ${token}`;
    return fetch(url, { method: 'GET', headers });
  }

  async function json(url: string): Promise<Response> {
    const response = await request(url, 'application/vnd.github+json');
    if (!response.ok) throw new GitHubError(url, response.status);
    return response;
  }

  return {
    async fileAt(repository, path, ref) {
      const url = `${API_ROOT}/repos/${repository}/contents/${path}?ref=${encodeURIComponent(ref)}`;
      const response = await request(url, 'application/vnd.github.raw+json');
      if (response.status === 404) return null;
      if (!response.ok) throw new GitHubError(url, response.status);
      return response.text();
    },
    async get<T>(path: string) {
      return (await (await json(`${API_ROOT}${path}`)).json()) as T;
    },
    async list<T>(path: string) {
      const items: T[] = [];
      let url: string | undefined = `${API_ROOT}${path}`;
      while (url) {
        const response = await json(url);
        items.push(...((await response.json()) as T[]));
        url = NEXT_PAGE.exec(response.headers.get('link') ?? '')?.[1];
      }
      return items;
    },
  };
}
