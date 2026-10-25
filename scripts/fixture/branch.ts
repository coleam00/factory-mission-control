import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CHECK_ENV_FILE,
  formatCheckEnv,
  loadCheckEnv,
  parseCheckEnv,
} from '../../server/check-env';
import { type Deps, failing, type Main, noArguments, runCli } from '../lib/cli';
import type { Db } from '../lib/db';
import { requireCheckBranch } from '../lib/guard';
import { type NeonApi, poll, waitForOperations } from '../lib/neon';
import { migrationsDir, readMigrationFiles, runMigrations } from '../migrate';
import { staleBranchPrefix } from './drop';

const PARENT_BRANCH = 'fixture';

const USAGE = [
  'usage: bun run fixture:branch (creates a check-* branch from fixture, migrates and seeds it, and writes .mc-check.env)',
  "       bun run fixture:branch --stale (creates <MC_CHECK_BRANCH>-stale-<id>, a bare branch that this checkout's fixture:drop deletes as stale and other sessions' drops leave until it is 3 hours old; an unattended check runs it, then fixture:drop, to prove stale cleanup while other sessions hold check-* branches)",
].join('\n');

function newCheckBranchName(prefix = 'check-'): string {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return `${prefix}${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

async function parentBranch(api: NeonApi): Promise<{ id: string }> {
  const parent = (await api.listBranches()).find((branch) => branch.name === PARENT_BRANCH);
  if (!parent) throw new Error(`no branch named ${PARENT_BRANCH}: the owner creates it from main`);
  return parent;
}

async function deleteAfterFailure(
  api: NeonApi,
  branch: { id: string; name: string },
  deps: Deps,
): Promise<void> {
  await api
    .deleteBranch(branch)
    .then((operations) => waitForOperations(api, operations, deps.sleep))
    .catch((cleanup) => deps.err(`could not delete ${branch.name}, fixture:drop will: ${cleanup}`));
}

/** A bare branch, no database work: `fixture:drop` only needs it to exist. */
async function createStaleBranch(deps: Deps): Promise<void> {
  loadCheckEnv(deps.repoRoot, deps.env);
  const own = deps.env.MC_CHECK_BRANCH;
  if (!own) {
    throw new Error(
      "--stale needs this checkout's check branch: run `bun run fixture:branch` first",
    );
  }
  requireCheckBranch(own);
  const api = deps.neon();
  const parent = await parentBranch(api);
  const name = newCheckBranchName(staleBranchPrefix(own));
  const created = await api.createBranch({ name, parentId: parent.id });
  try {
    await waitForOperations(api, created.operations, deps.sleep);
  } catch (error) {
    await deleteAfterFailure(api, { id: created.branch.id, name }, deps);
    throw error;
  }
  deps.out(`created ${name} (stale for fixture:drop)`);
}

const CONNECT_ATTEMPTS = 10;

/** A new branch's compute may still be starting when its operations finish. */
async function waitForCompute(db: Db, deps: Deps): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await db.query('SELECT 1');
      return;
    } catch (error) {
      if (attempt === CONNECT_ATTEMPTS) throw error;
      await deps.sleep(2000);
    }
  }
}

async function prepareDatabase(url: string, deps: Deps): Promise<void> {
  const db = deps.openDb(url);
  try {
    await waitForCompute(db, deps);
    for (const name of await runMigrations({
      files: readMigrationFiles(migrationsDir(deps.repoRoot)),
      db,
    })) {
      deps.out(`applied ${name}`);
    }
    const seed = join(deps.repoRoot, 'fixtures', 'seed.sql');
    if (existsSync(seed)) {
      const sql = readFileSync(seed, 'utf-8');
      await db.transaction((tx) => tx.query(sql).then(() => undefined));
      deps.out('loaded fixtures/seed.sql');
    }
  } finally {
    await db.close();
  }
}

async function createSessionBranch(deps: Deps): Promise<void> {
  const envFile = join(deps.repoRoot, CHECK_ENV_FILE);
  const existing = existsSync(envFile)
    ? parseCheckEnv(readFileSync(envFile, 'utf-8')).MC_CHECK_BRANCH
    : undefined;
  if (existing) {
    throw new Error(
      `${CHECK_ENV_FILE} already names ${existing}: run \`bun run fixture:drop\` first`,
    );
  }
  const api = deps.neon();
  const parent = await parentBranch(api);

  const name = newCheckBranchName();
  const created = await api.createBranch({ name, parentId: parent.id });
  const branch = { id: created.branch.id, name };
  try {
    await waitForOperations(api, created.operations, deps.sleep);
    const url = created.connection_uris?.[0]?.connection_uri;
    if (!url)
      throw new Error(
        `Neon returned no connection string: ${PARENT_BRANCH} has several roles or databases`,
      );
    await poll(
      `Realtime on ${name}`,
      async () => {
        const realtime = await api.getRealtime(branch.id);
        return realtime.enabled && !realtime.pending ? true : undefined;
      },
      { sleep: deps.sleep },
    );
    const secret = await api.getRealtimeSecret(branch.id);
    await prepareDatabase(url, deps);
    writeFileSync(
      envFile,
      formatCheckEnv({
        MC_CHECK_BRANCH: name,
        MC_DATABASE_URL: url,
        NEON_REALTIME_SECRET: secret,
      }),
    );
  } catch (error) {
    await deleteAfterFailure(api, branch, deps);
    throw error;
  }
  deps.out(`created ${name}`);
  deps.out(`wrote ${CHECK_ENV_FILE}`);
}

export const main: Main = async (argv, deps) => {
  if (argv.length === 1 && argv[0] === '--stale')
    return failing(deps, () => createStaleBranch(deps));
  return (
    noArguments(argv, USAGE, deps, ['--stale']) ?? failing(deps, () => createSessionBranch(deps))
  );
};

if (import.meta.main) await runCli(main);
