// The Function's only way to reach GitHub. Requests are GETs by type, never anything else
// (invariant 2: read-only toward the factories).

export type GetFetch = (
  url: string,
  init: { method: 'GET'; headers: Record<string, string> },
) => Promise<Response>;

export interface GitHub {
  /** The file's text at `ref`, or null when the file does not exist there. */
  fileAt(repository: string, path: string, ref: string): Promise<string | null>;
}

export function createGitHub(fetch: GetFetch = globalThis.fetch): GitHub {
  return {
    async fileAt(repository, path, ref) {
      const url = `https://api.github.com/repos/${repository}/contents/${path}?ref=${encodeURIComponent(ref)}`;
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          accept: 'application/vnd.github.raw+json',
          'user-agent': 'factory-mission-control',
          'x-github-api-version': '2022-11-28',
        },
      });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`GET ${url} failed: ${response.status}`);
      return response.text();
    },
  };
}
