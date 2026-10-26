import { parseArgs } from 'node:util';
import { loadCheckEnv } from '../server/check-env';
import { ISO_TIME } from './fixture/drop';
import { type Deps, failing, type Main, runCli } from './lib/cli';
import { requireCheckBranch } from './lib/guard';
import { type NeonApi, poll, waitForOperations } from './lib/neon';
import { resolveBranchName } from './lib/target';

/** Neon keeps a branch's history this long, so a branch can start from no earlier moment. */
export const REWIND_DAYS = 7;

const USAGE =
  "usage: bun run rewind:create <ISO time> [--parent <branch>] (makes Neon branch rewind-<time> from <branch>, default main, as it was at that time, at most 7 days back, and lists it on the dashboard's branch: a check-* branch, or main when the owner confirms at a terminal)";

/** `2026-10-25T12:00:00Z` is `rewind-2026-10-25t12-00-00z`: UTC to the second, as a branch name allows. */
export function rewindBranchName(at: Date): string {
  return `rewind-${at.toISOString().slice(0, 19).toLowerCase().replace(/:/g, '-')}z`;
}

/** The moment `value` names, or why it cannot start a rewind branch. Asks nothing of Neon. */
function rewindTime(value: string, now: Date): Date {
  const at = new Date(value);
  if (at.getTime() > now.getTime()) throw new Error(`${value} is in the future`);
  if (now.getTime() - at.getTime() > REWIND_DAYS * 86_400_000) {
    throw new Error(
      `refusing ${value}: more than ${REWIND_DAYS} days back; Neon keeps ${REWIND_DAYS} days of history`,
    );
  }
  return at;
}

/**
 * The branch the dashboard serves, which lists the rewind: a check branch, or `main` only when
 * the owner confirms at a terminal. Nothing connects to it before this returns.
 */
async function servedBranch(deps: Deps, api: NeonApi): Promise<{ url: string; name: string }> {
  loadCheckEnv(deps.repoRoot, deps.env);
  const url = deps.env.MC_DATABASE_URL;
  if (!url) throw new Error('MC_DATABASE_URL is not set: run `bun run fixture:branch` first');
  const name = await resolveBranchName(url, api);
  if (name === 'main') {
    if (!deps.confirmOwner(deps.env.NEON_PROJECT_ID ?? '')) {
      throw new Error('rewind:create lists a rewind on main only for the owner, at a terminal');
    }
  } else {
    requireCheckBranch(name);
  }
  return { url, name };
}

async function createRewind(deps: Deps, value: string, parentName: string): Promise<void> {
  const at = rewindTime(value, deps.now());
  const name = rewindBranchName(at);
  const api = deps.neon();
  const served = await servedBranch(deps, api);
  const branches = await api.listBranches();
  const parent = branches.find((branch) => branch.name === parentName);
  if (!parent) throw new Error(`no branch named ${parentName}`);
  if (branches.some((branch) => branch.name === name)) throw new Error(`${name} already exists`);

  deps.out(`creating ${name} from ${parent.name} at ${at.toISOString()}`);
  const created = await api.createRewindBranch({
    name,
    parentId: parent.id,
    at: at.toISOString(),
  });
  const branch = { id: created.branch.id, name };
  try {
    await waitForOperations(api, created.operations, deps.sleep);
    await poll(
      `Realtime on ${name}`,
      async () => {
        const realtime = await api.getRealtime(branch.id);
        return realtime.enabled && !realtime.pending ? true : undefined;
      },
      { sleep: deps.sleep },
    );
    // test:live times a new rewind's way to the screen from this line.
    deps.out(`registering ${name} in mc.rewind_branches on ${served.name}`);
    const db = deps.openDb(served.url);
    try {
      await db.query('INSERT INTO mc.rewind_branches (name, parent, at) VALUES ($1, $2, $3)', [
        name,
        parent.name,
        at.toISOString(),
      ]);
    } finally {
      await db.close();
    }
  } catch (error) {
    await api
      .deleteRewindBranch(branch)
      .then((operations) => waitForOperations(api, operations, deps.sleep))
      .catch((cleanup) => deps.err(`could not delete ${name}: ${cleanup}`));
    throw error;
  }
  deps.out(`created ${name}`);
}

export const main: Main = async (argv, deps) => {
  let parsed: { values: { parent?: string; help?: boolean }; positionals: string[] };
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: { parent: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
    });
  } catch (error) {
    deps.err(error instanceof Error ? `${error.message}\n${USAGE}` : USAGE);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    deps.out(USAGE);
    return 0;
  }
  const [value] = positionals;
  if (
    positionals.length !== 1 ||
    value === undefined ||
    !ISO_TIME.test(value) ||
    Number.isNaN(Date.parse(value))
  ) {
    deps.err(`rewind:create takes one ISO-8601 time with a zone\n${USAGE}`);
    return 2;
  }
  return failing(deps, () => createRewind(deps, value, values.parent ?? 'main'));
};

if (import.meta.main) await runCli(main);
