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

export type Recorder = {
  deps: Deps;
  neonCalls: string[];
  mutatingCalls: string[];
  opened: string[];
  sql: string[];
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
}): Recorder {
  const recorder: Omit<Recorder, 'deps'> = {
    neonCalls: [],
    mutatingCalls: [],
    opened: [],
    sql: [],
    out: [],
    err: [],
  };
  const branches = options.branches ?? [];
  const call = (name: string) => recorder.neonCalls.push(name);
  const mutate = (name: string) => {
    call(name);
    recorder.mutatingCalls.push(name);
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
    async createBranch({ name }) {
      mutate(`createBranch ${name}`);
      return { branch: { id: 'br-new', name, created_at: NOW.toISOString() }, operations: [] };
    },
    async deleteBranch({ name }) {
      mutate(`deleteBranch ${name}`);
      return [];
    },
  };
  const rows = options.rows ?? (() => []);
  const db: Db = {
    async query(sql) {
      recorder.sql.push(sql);
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
