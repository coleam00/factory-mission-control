import { expect, test } from 'bun:test';
import { SERVE_PORTS } from '../../server/ports';
import { createNeonApi } from './neon';

type Request = { url: string; method: string; body?: unknown };

function fakeNeon(respond: (request: Request) => unknown) {
  const requests: Request[] = [];
  const api = createNeonApi({
    apiKey: 'key',
    projectId: 'proj',
    fetch: async (url, init) => {
      const request = {
        url,
        method: init.method ?? 'GET',
        body: init.body ? JSON.parse(String(init.body)) : undefined,
      };
      requests.push(request);
      return Response.json(respond(request));
    },
  });
  return { api, requests };
}

test('listBranches follows pagination.next', async () => {
  const { api, requests } = fakeNeon(({ url }) =>
    new URL(url).searchParams.get('cursor') === 'page-2'
      ? { branches: [{ id: 'br-2', name: 'fixture', created_at: '' }], pagination: {} }
      : {
          branches: [{ id: 'br-1', name: 'main', created_at: '' }],
          pagination: { next: 'page-2' },
        },
  );
  expect((await api.listBranches()).map((branch) => branch.name)).toEqual(['main', 'fixture']);
  expect(requests).toHaveLength(2);
});

test.each(['main', 'fixture', 'rewind-x'])(
  'createBranch and deleteBranch refuse %s without a request',
  async (name) => {
    const { api, requests } = fakeNeon(() => ({ operations: [] }));
    await expect(api.deleteBranch({ id: 'br-x', name })).rejects.toThrow(
      `refusing branch '${name}'`,
    );
    await expect(api.createBranch({ name, parentId: 'br-fixture' })).rejects.toThrow(
      `refusing branch '${name}'`,
    );
    expect(requests).toEqual([]);
  },
);

test('createBranch asks for a read-write compute and Realtime for the 16 allowed origins', async () => {
  const { api, requests } = fakeNeon(() => ({
    branch: { id: 'br-new', name: 'check-0a1b2c3d', created_at: '' },
    operations: [],
  }));
  await api.createBranch({ name: 'check-0a1b2c3d', parentId: 'br-fixture' });
  const [request] = requests;
  expect(request.method).toBe('POST');
  expect(request.url).toBe('https://console.neon.tech/api/v2/projects/proj/branches');
  const body = request.body as {
    branch: { name: string; parent_id: string; realtime: { allowed_origins: string[] } };
    endpoints: unknown;
  };
  expect(body.branch.name).toBe('check-0a1b2c3d');
  expect(body.branch.parent_id).toBe('br-fixture');
  expect(body.branch.realtime.allowed_origins).toHaveLength(16);
  expect(body.branch.realtime.allowed_origins).toContain('http://localhost:5173');
  expect(body.branch.realtime.allowed_origins).toContain(`http://localhost:${SERVE_PORTS.min}`);
  expect(body.branch.realtime.allowed_origins).toContain(`http://localhost:${SERVE_PORTS.max}`);
  expect(body.endpoints).toEqual([{ type: 'read_write' }]);
});

test('a failed request names the method, path and status, never the key', async () => {
  const api = createNeonApi({
    apiKey: 'secret-key',
    projectId: 'proj',
    fetch: async () => new Response('not found', { status: 404 }),
  });
  const error = await api.getBranch('br-x').catch((e: Error) => e);
  expect(String(error)).toContain('GET /projects/proj/branches/br-x failed: 404');
  expect(String(error)).not.toContain('secret-key');
});
