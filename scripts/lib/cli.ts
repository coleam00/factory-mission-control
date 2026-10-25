import { resolve } from 'node:path';
import { type Env, loadCheckEnv } from '../../server/check-env';
import { type OpenDb, openDb } from './db';
import { RefusedBranch, requireCheckBranch } from './guard';
import { createNeonApi, type NeonApi, type Sleep } from './neon';
import { resolveBranchName } from './target';

export const REPO_ROOT = resolve(import.meta.dir, '..', '..');

/** Everything a command touches outside itself, so tests can record it. */
export type Deps = {
  env: Env;
  repoRoot: string;
  neon: () => NeonApi;
  openDb: OpenDb;
  now: () => Date;
  sleep: Sleep;
  out: (line: string) => void;
  err: (line: string) => void;
  /** Only `migrate:main` asks; true when the owner, at a terminal, confirmed the project. */
  confirmOwner: (projectId: string) => boolean;
};

export type Main = (argv: string[], deps: Deps) => Promise<number>;

function neonFromEnv(env: Env): NeonApi {
  const apiKey = env.NEON_API_KEY;
  const projectId = env.NEON_PROJECT_ID;
  if (!apiKey || !projectId) throw new Error('NEON_API_KEY and NEON_PROJECT_ID must be set');
  return createNeonApi({ apiKey, projectId });
}

function confirmOwnerAtTerminal(projectId: string): boolean {
  if (!process.stdin.isTTY) return false;
  return prompt(`Type the Neon project id (${projectId}) to migrate main:`) === projectId;
}

export function defaultDeps(): Deps {
  return {
    env: Bun.env,
    repoRoot: REPO_ROOT,
    neon: () => neonFromEnv(Bun.env),
    openDb,
    now: () => new Date(),
    sleep: (ms) => Bun.sleep(ms),
    out: (line) => console.log(line),
    err: (line) => console.error(line),
    confirmOwner: confirmOwnerAtTerminal,
  };
}

export async function runCli(main: Main): Promise<never> {
  process.exit(await main(Bun.argv.slice(2), defaultDeps()));
}

/** Runs `work`, turning any failure (a refusal included) into its message and exit code 1. */
export async function failing(deps: Deps, work: () => Promise<void>): Promise<number> {
  try {
    await work();
    return 0;
  } catch (error) {
    deps.err(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

/**
 * `MC_DATABASE_URL` once the Neon API says it points at a `check-*` branch, or, for the owner's
 * `migrate:main`, at `main`. Nothing may connect to the URL before this returns.
 */
export async function guardedDatabaseUrl(deps: Deps, target: 'check' | 'main'): Promise<string> {
  loadCheckEnv(deps.repoRoot, deps.env);
  const url = deps.env.MC_DATABASE_URL;
  if (!url) throw new Error('MC_DATABASE_URL is not set: run `bun run fixture:branch` first');
  const name = await resolveBranchName(url, deps.neon());
  if (target === 'check') {
    requireCheckBranch(name);
    return url;
  }
  if (name !== 'main') throw new RefusedBranch(name, 'migrate:main only migrates main');
  if (!deps.confirmOwner(deps.env.NEON_PROJECT_ID ?? '')) {
    throw new Error('migrate:main is for the owner, at a terminal');
  }
  return url;
}
