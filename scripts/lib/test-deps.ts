import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGitHub, type GetFetch } from '../../function/github';
import { CHECK_ENV_FILE, type Env } from '../../server/check-env';
import type { Deps, NeonctlResult } from './cli';
import type { Db, Row } from './db';
import type { Branch, NeonApi } from './neon';

export const NOW = new Date('2026-10-24T12:00:00Z');
export const PROJECT = 'proj-test';

export function hoursAgo(hours: number): string {
  return new Date(NOW.getTime() - hours * 3_600_000).toISOString();
}

/** A connection string the fake Neon resolves to `branchName`. */
export const DATABASE_URL = 'postgresql://u:p@ep-fake-endpoint-a1b2c3.us-east-2.aws.neon.tech/db';

/** The connection string the fake Neon returns for every branch it creates. */
export const CREATED_URL = 'postgresql://u:p@ep-created-d4e5f6.us-east-2.aws.neon.tech/db';

/** The pooled connection string the fake Neon returns for every branch. */
export const POOLED_URL =
  'postgresql://u:pooled-pw@ep-fake-pooler-a1b2c3.us-east-2.aws.neon.tech/db?sslmode=require&channel_binding=require';

/** The `invocation_url` the fake neonctl reports for every deploy. */
export const FUNCTION_URL = 'https://br-check-mcwebhook.compute.c-1.us-east-1.aws.neon.tech';

export type Recorder = {
  deps: Deps;
  neonCalls: string[];
  mutatingCalls: string[];
  /** Every GitHub URL requested; the fake answers none of them. */
  githubCalls: string[];
  opened: string[];
  sql: string[];
  /** Every request a command sent through `deps.fetch`, as `<method> <url>`. */
  requests: string[];
  /** Each query's parameters, in the order `sql` holds its text. */
  params: (unknown[] | undefined)[];
  /** Every neonctl argv, in order. */
  neonctlCalls: string[][];
  out: string[];
  err: string[];
};

export function scratchRepo(checkEnv?: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'mc-scripts-'));
  if (checkEnv) {
    writeFileSync(
      join(dir, CHECK_ENV_FILE),
      Object.entries(checkEnv)
        .map(([key, value]) => `${key}=${value}\n`)
        .join(''),
    );
  }
  return dir;
}

/**
 * Deps over a fake Neon project holding `branches`, where `DATABASE_URL` belongs to `branchName`,
 * and a database that answers every query with `rows(sql)`. Every call is recorded.
 */
export function recordingDeps(options: {
  repoRoot: string;
  env?: Env;
  branches?: Branch[];
  branchName?: string;
  rows?: (sql: string) => Row[];
  owner?: boolean;
  /** Recorded calls (`deleteBranch check-old`, `getRealtimeSecret br-new`) that throw instead. */
  throwsOn?: string[];
  /** Answers `deps.fetch`; without it every request fails, as with no network. */
  fetch?: GetFetch;
  /** Answers `deps.neonctl`; without it every call succeeds as a deploy reporting `FUNCTION_URL`. */
  neonctl?: (args: string[]) => NeonctlResult;
}): Recorder {
  const recorder: Omit<Recorder, 'deps'> = {
    neonCalls: [],
    mutatingCalls: [],
    githubCalls: [],
    opened: [],
    sql: [],
    requests: [],
    params: [],
    neonctlCalls: [],
    out: [],
    err: [],
  };
  const branches = options.branches ?? [];
  const call = (name: string) => {
    recorder.neonCalls.push(name);
    if (options.throwsOn?.includes(name)) throw new Error(`fake Neon: ${name} failed`);
  };
  const mutate = (name: string) => {
    recorder.mutatingCalls.push(name);
    call(name);
  };
  const neon: NeonApi = {
    async listBranches() {
      call('listBranches');
      return branches;
    },
    async getEndpoint(id) {
      call(`getEndpoint ${id}`);
      return { id, branch_id: 'br-target', host: `${id}.us-east-2.aws.neon.tech` };
    },
    async branchEndpoints(branchId) {
      call(`branchEndpoints ${branchId}`);
      const id = 'ep-rewind-a1b2c3';
      return [{ id, branch_id: branchId, host: `${id}.us-east-2.aws.neon.tech` }];
    },
    async getBranch(id) {
      call(`getBranch ${id}`);
      return { id, name: options.branchName ?? 'check-abc', created_at: hoursAgo(1) };
    },
    async getOperation(id) {
      call(`getOperation ${id}`);
      return { id, status: 'finished' };
    },
    async getRealtime(branchId) {
      call(`getRealtime ${branchId}`);
      return { enabled: true, pending: false };
    },
    async getRealtimeSecret(branchId) {
      call(`getRealtimeSecret ${branchId}`);
      return 'nrt_live_1fake';
    },
    async pooledConnectionUri(branchId) {
      call(`pooledConnectionUri ${branchId}`);
      return POOLED_URL;
    },
    async createBranch({ name, parentId }) {
      mutate(`createBranch ${name} from ${parentId}`);
      return {
        branch: { id: 'br-new', name, created_at: NOW.toISOString() },
        operations: [],
        connection_uris: [{ connection_uri: CREATED_URL }],
      };
    },
    async deleteBranch({ name }) {
      mutate(`deleteBranch ${name}`);
      return [];
    },
    async createRewindBranch({ name, parentId, at }) {
      mutate(`createRewindBranch ${name} from ${parentId} at ${at}`);
      return { branch: { id: 'br-rewind', name, created_at: NOW.toISOString() }, operations: [] };
    },
    async deleteRewindBranch({ name }) {
      mutate(`deleteRewindBranch ${name}`);
      return [];
    },
  };
  const rows = options.rows ?? (() => []);
  const db: Db = {
    async query(sql, params) {
      recorder.sql.push(sql);
      recorder.params.push(params);
      return rows(sql);
    },
    async transaction(fn) {
      await fn(db);
    },
    async close() {},
  };
  const deps: Deps = {
    env: { NEON_PROJECT_ID: PROJECT, ...options.env },
    repoRoot: options.repoRoot,
    neon: () => neon,
    github: () =>
      createGitHub(async (url) => {
        recorder.githubCalls.push(url);
        throw new Error(`fake GitHub: no response for ${url}`);
      }),
    openDb: (url) => {
      recorder.opened.push(url);
      return db;
    },
    fetch: async (url, init) => {
      recorder.requests.push(`${init.method} ${url}`);
      if (!options.fetch) throw new Error(`fake network: no route to ${url}`);
      return options.fetch(url, init);
    },
    now: () => NOW,
    sleep: async () => {},
    out: (line) => recorder.out.push(line),
    err: (line) => recorder.err.push(line),
    confirmOwner: () => options.owner ?? false,
    neonctl: async (args) => {
      recorder.neonctlCalls.push(args);
      if (options.neonctl) return options.neonctl(args);
      const report = { id: 1, status: 'completed', invocation_url: FUNCTION_URL };
      return { code: 0, stdout: `${JSON.stringify(report)}\n`, stderr: '' };
    },
  };
  return { ...recorder, deps };
}
