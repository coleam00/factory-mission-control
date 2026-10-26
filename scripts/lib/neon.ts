import { SERVE_PORTS } from '../../server/ports';
import { requireCheckBranch, requireRewindBranch } from './guard';

const API_BASE = 'https://console.neon.tech/api/v2';

/** PRD 11.3: Vite dev and every serve port; Neon allows at most 16 origins. */
export const REALTIME_ORIGINS = [
  'http://localhost:5173',
  ...Array.from(
    { length: SERVE_PORTS.max - SERVE_PORTS.min + 1 },
    (_, i) => `http://localhost:${SERVE_PORTS.min + i}`,
  ),
];

export type Branch = { id: string; name: string; created_at: string };
export type Endpoint = { id: string; branch_id: string; host: string };
export type Operation = { id: string; status: string };
export type Realtime = { enabled: boolean; pending: boolean };
export type CreatedBranch = {
  branch: Branch;
  operations: Operation[];
  connection_uris?: { connection_uri: string }[];
};

export interface NeonApi {
  listBranches(): Promise<Branch[]>;
  getBranch(id: string): Promise<Branch>;
  getEndpoint(id: string): Promise<Endpoint>;
  branchEndpoints(branchId: string): Promise<Endpoint[]>;
  getOperation(id: string): Promise<Operation>;
  getRealtime(branchId: string): Promise<Realtime>;
  getRealtimeSecret(branchId: string): Promise<string>;
  /** The pooled connection string of the branch's only database, as its owner role (read-only). */
  pooledConnectionUri(branchId: string): Promise<string>;
  /** Refuses a name that is not `check-*` before any request. */
  createBranch(input: { name: string; parentId: string }): Promise<CreatedBranch>;
  /** Refuses a name that is not `check-*` before any request. */
  deleteBranch(branch: { id: string; name: string }): Promise<Operation[]>;
  /** The parent as it was at `at` (ISO time). Refuses a name that is not `rewind-*` before any request. */
  createRewindBranch(input: { name: string; parentId: string; at: string }): Promise<CreatedBranch>;
  /** Refuses a name that is not `rewind-*` before any request. */
  deleteRewindBranch(branch: { id: string; name: string }): Promise<Operation[]>;
}

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export function createNeonApi(options: {
  apiKey: string;
  projectId: string;
  fetch?: Fetch;
}): NeonApi {
  const doFetch = options.fetch ?? fetch;
  const project = `/projects/${encodeURIComponent(options.projectId)}`;

  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await doFetch(`${API_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 300);
      throw new Error(`Neon API ${method} ${path} failed: ${res.status} ${detail}`);
    }
    return (await res.json()) as T;
  }

  const branchPath = (id: string) => `${project}/branches/${encodeURIComponent(id)}`;

  return {
    async listBranches() {
      const branches: Branch[] = [];
      let cursor: string | undefined;
      do {
        const query = new URLSearchParams({ limit: '10000' });
        if (cursor) query.set('cursor', cursor);
        const page = await call<{ branches: Branch[]; pagination?: { next?: string } }>(
          'GET',
          `${project}/branches?${query}`,
        );
        branches.push(...page.branches);
        cursor = page.pagination?.next;
      } while (cursor);
      return branches;
    },
    async getBranch(id) {
      return (await call<{ branch: Branch }>('GET', branchPath(id))).branch;
    },
    async getEndpoint(id) {
      const path = `${project}/endpoints/${encodeURIComponent(id)}`;
      return (await call<{ endpoint: Endpoint }>('GET', path)).endpoint;
    },
    async branchEndpoints(branchId) {
      return (await call<{ endpoints: Endpoint[] }>('GET', `${branchPath(branchId)}/endpoints`))
        .endpoints;
    },
    async getOperation(id) {
      const path = `${project}/operations/${encodeURIComponent(id)}`;
      return (await call<{ operation: Operation }>('GET', path)).operation;
    },
    getRealtime(branchId) {
      return call<Realtime>('GET', `${branchPath(branchId)}/realtime`);
    },
    async getRealtimeSecret(branchId) {
      return (await call<{ secret: string }>('GET', `${branchPath(branchId)}/realtime/secret`))
        .secret;
    },
    async pooledConnectionUri(branchId) {
      const { databases } = await call<{ databases: { name: string; owner_name: string }[] }>(
        'GET',
        `${branchPath(branchId)}/databases`,
      );
      const [database] = databases;
      if (databases.length !== 1) {
        throw new Error(
          `branch ${branchId} has ${databases.length} databases; function:deploy needs exactly one`,
        );
      }
      const query = new URLSearchParams({
        branch_id: branchId,
        database_name: database.name,
        role_name: database.owner_name,
        pooled: 'true',
      });
      return (await call<{ uri: string }>('GET', `${project}/connection_uri?${query}`)).uri;
    },
    async createBranch({ name, parentId }) {
      requireCheckBranch(name);
      return call<CreatedBranch>('POST', `${project}/branches`, {
        branch: { name, parent_id: parentId, realtime: { allowed_origins: REALTIME_ORIGINS } },
        endpoints: [{ type: 'read_write' }],
      });
    },
    async deleteBranch({ id, name }) {
      requireCheckBranch(name);
      return (await call<{ operations: Operation[] }>('DELETE', branchPath(id))).operations;
    },
    async createRewindBranch({ name, parentId, at }) {
      requireRewindBranch(name);
      return call<CreatedBranch>('POST', `${project}/branches`, {
        branch: {
          name,
          parent_id: parentId,
          parent_timestamp: at,
          realtime: { allowed_origins: REALTIME_ORIGINS },
        },
        endpoints: [{ type: 'read_write' }],
      });
    },
    async deleteRewindBranch({ id, name }) {
      requireRewindBranch(name);
      return (await call<{ operations: Operation[] }>('DELETE', branchPath(id))).operations;
    },
  };
}

export type Sleep = (ms: number) => Promise<void>;

/** Calls `probe` every `intervalMs` until it returns a value, failing after `timeoutMs`. */
export async function poll<T>(
  what: string,
  probe: () => Promise<T | undefined>,
  { intervalMs = 1000, timeoutMs = 120_000, sleep = Bun.sleep as Sleep } = {},
): Promise<T> {
  for (let waited = 0; ; waited += intervalMs) {
    const value = await probe();
    if (value !== undefined) return value;
    if (waited >= timeoutMs) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await sleep(intervalMs);
  }
}

const OPERATION_FAILED = new Set(['failed', 'error', 'cancelling', 'cancelled']);

export async function waitForOperations(
  api: NeonApi,
  operations: Operation[],
  sleep?: Sleep,
): Promise<void> {
  for (const { id } of operations) {
    await poll(
      `operation ${id}`,
      async () => {
        const { status } = await api.getOperation(id);
        if (OPERATION_FAILED.has(status)) throw new Error(`operation ${id} ended ${status}`);
        return status === 'finished' || status === 'skipped' ? true : undefined;
      },
      { sleep },
    );
  }
}
