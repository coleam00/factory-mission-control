import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CHECK_ENV_FILE, formatCheckEnv, parseCheckEnv } from '../../server/check-env';
import { type Deps, failing, type Main, runCli } from '../lib/cli';
import type { Db } from '../lib/db';
import { poll, waitForOperations } from '../lib/neon';
import { migrationsDir, readMigrationFiles, runMigrations } from '../migrate';

const PARENT_BRANCH = 'fixture';

function newCheckBranchName(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return `check-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
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

export const main: Main = async (_argv, deps) =>
  failing(deps, async () => {
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
    const parent = (await api.listBranches()).find((branch) => branch.name === PARENT_BRANCH);
    if (!parent)
      throw new Error(`no branch named ${PARENT_BRANCH}: the owner creates it from main`);

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
      await api
        .deleteBranch(branch)
        .then((operations) => waitForOperations(api, operations, deps.sleep))
        .catch((cleanup) => deps.err(`could not delete ${name}, fixture:drop will: ${cleanup}`));
      throw error;
    }
    deps.out(`created ${name}`);
    deps.out(`wrote ${CHECK_ENV_FILE}`);
  });

if (import.meta.main) await runCli(main);
