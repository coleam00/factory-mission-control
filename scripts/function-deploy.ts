// `bun run function:deploy -- --branch <branch>`: deploys `function/index.ts` as the Neon Function
// `mcwebhook` on that branch and prints its URL (PRD 11.3).
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { type Deps, failing, type Main, runCli } from './lib/cli';
import { isCheckBranch, RefusedBranch } from './lib/guard';
import type { Branch, NeonApi } from './lib/neon';

export const SLUG = 'mcwebhook';

const USAGE = [
  `usage: bun run function:deploy -- --branch <check-*|main> (deploys the webhook Function ${SLUG} to that branch with GITHUB_WEBHOOK_SECRET and GITHUB_TOKEN from the environment, and prints its URL)`,
  `       bun run function:deploy -- --branch <check-*|main> --delete (deletes ${SLUG} from that branch)`,
].join('\n');

type Target = { api: NeonApi; branch: Branch; projectId: string };

async function targetBranch(deps: Deps, name: string): Promise<Target> {
  if (name !== 'main' && !isCheckBranch(name)) {
    throw new RefusedBranch(
      name,
      'function:deploy deploys to a check-* branch, or to main only when given --branch main',
    );
  }
  const api = deps.neon();
  const branch = (await api.listBranches()).find((candidate) => candidate.name === name);
  if (!branch) throw new Error(`no branch named ${name}`);
  return { api, branch, projectId: String(deps.env.NEON_PROJECT_ID) };
}

/** `text` with every given secret, longest first, replaced by `***`. */
function redacted(text: string, secrets: string[]): string {
  return secrets
    .filter((secret) => secret.length > 0)
    .sort((a, b) => b.length - a.length)
    .reduce((out, secret) => out.replaceAll(secret, '***'), text);
}

async function deploy(deps: Deps, { api, branch, projectId }: Target): Promise<void> {
  const secret = deps.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) {
    throw new Error('GITHUB_WEBHOOK_SECRET must be set: GitHub signs every delivery with it');
  }
  // Sent even when empty: neonctl keeps any key a deploy leaves out from the one before.
  const token = deps.env.GITHUB_TOKEN ?? '';
  const url = await api.pooledConnectionUri(branch.id);
  const result = await deps.neonctl([
    'functions',
    'deploy',
    SLUG,
    '--src',
    join(deps.repoRoot, 'function', 'index.ts'),
    '--runtime',
    'nodejs24',
    '--project-id',
    projectId,
    '--branch',
    branch.id,
    '--env',
    `MC_DATABASE_URL=${url}`,
    '--env',
    `GITHUB_WEBHOOK_SECRET=${secret}`,
    '--env',
    `GITHUB_TOKEN=${token}`,
    '--output',
    'json',
  ]);
  if (result.code !== 0) {
    const secrets = [url, new URL(url).password, secret, token];
    throw new Error(`neonctl functions deploy failed: ${redacted(result.stderr.trim(), secrets)}`);
  }
  let invocationUrl: unknown;
  try {
    invocationUrl = (JSON.parse(result.stdout) as { invocation_url?: unknown }).invocation_url;
  } catch {}
  if (typeof invocationUrl !== 'string') {
    throw new Error(`neonctl reported no invocation_url for ${SLUG}`);
  }
  deps.out(invocationUrl);
}

async function remove(deps: Deps, { branch, projectId }: Target): Promise<void> {
  const args = ['functions', 'delete', SLUG, '--project-id', projectId, '--branch', branch.id];
  const result = await deps.neonctl(args);
  if (result.code !== 0) {
    throw new Error(`neonctl functions delete failed: ${result.stderr.trim()}`);
  }
  deps.out(`deleted ${SLUG} from ${branch.name}`);
}

export const main: Main = async (argv, deps) => {
  let values: { branch?: string; delete?: boolean; help?: boolean };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        branch: { type: 'string' },
        delete: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    }));
  } catch (error) {
    deps.err(error instanceof Error ? `${error.message}\n${USAGE}` : USAGE);
    return 2;
  }
  if (values.help) {
    deps.out(USAGE);
    return 0;
  }
  const name = values.branch;
  if (name === undefined) {
    deps.err(USAGE);
    return 2;
  }
  return failing(deps, async () => {
    const target = await targetBranch(deps, name);
    await (values.delete ? remove(deps, target) : deploy(deps, target));
  });
};

if (import.meta.main) await runCli(main);
