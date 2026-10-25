import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHECK_ENV_FILE, type Env } from '../../server/check-env';
import type { Deps } from './cli';
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

export type Recorder = {
  deps: Deps;
  neonCalls: string[];
  mutatingCalls: string[];
  opened: string[];
  sql: string[];
  /** Each query's parameters, in the order `sql` holds its text. */
  params: (unknown[] | undefined)[];
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
}): Recorder {
  const recorder: Omit<Recorder, 'deps'> = {
    neonCalls: [],
    mutatingCalls: [],
    opened: [],
    sql: [],
    params: [],
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
      return { id, branch_id: 'br-target' };
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
    openDb: (url) => {
      recorder.opened.push(url);
      return db;
    },
    now: () => NOW,
    sleep: async () => {},
    out: (line) => recorder.out.push(line),
    err: (line) => recorder.err.push(line),
    confirmOwner: () => options.owner ?? false,
  };
  return { ...recorder, deps };
}
