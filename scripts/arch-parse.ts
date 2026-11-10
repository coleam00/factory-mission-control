import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  FACTORY_PACKAGE_DIR,
  HOOKS_DIR,
  type PackVersion,
  parseVersion,
  type Step,
} from '../parsers/pack';
import { type Deps, failing, guardedDatabaseUrl, type Main, runCli } from './lib/cli';
import type { SqlRow, Tx } from './lib/db';
import { type RemoteDirectory, readDirectoryAt } from './lib/github';

// The architecture job (PRD 11.4): one version's pack, factory package and factory template hooks
// (whichever the factory commit has), parsed and stored as that version's architecture rows. A version is keyed by full commit shas, whichever form the
// command was given.

export const ARCHON_REPOSITORY = 'coleam00/Archon';
export const PACK_DIR = '.archon/workflows/sdlc';
export const FACTORY_REPOSITORY = 'coleam00/ai-software-factory';
const TEMPLATE_DIR = 'template';
/** Only the parts of the factory repository the parser reads, so no holdout scenario file is ever fetched. */
export const FACTORY_HOOKS_DIR = `${TEMPLATE_DIR}/${HOOKS_DIR}`;

/** Every table a version owns rows in, besides `mc.arch_versions`. */
export const ARCH_TABLES = [
  'arch_workflows',
  'arch_steps',
  'arch_edges',
  'arch_texts',
  'arch_scripts',
  'arch_subagents',
  'arch_hooks',
] as const;
export type ArchTable = (typeof ARCH_TABLES)[number];

const USAGE =
  'usage: bun run arch:parse <archon-sha> <factory-sha> [--archon-path <dir holding sdlc/>] [--factory-path <template dir>] [--package-path <factory package dir>] | bun run arch:parse:main ... (the owner, at a terminal)';

const SHA = /^[0-9a-f]{7,40}$/;

interface Version {
  archonSha: string;
  factorySha: string;
  pack: PackVersion;
}

type ArchRows = Record<ArchTable, SqlRow[]>;

/** Each workflow's expanded tree in parser order: a step, then its children, then its next sibling. */
function stepRows(
  workflow: string,
  steps: Step[],
  parent: string | null,
  into: SqlRow[],
): SqlRow[] {
  for (const step of steps) {
    into.push({
      workflow,
      path: step.path,
      parent_path: parent,
      position: into.length,
      step_id: step.id,
      kind: step.kind,
      description: step.description,
      model: step.model,
      when_condition: step.when,
      depends_on: step.dependsOn,
      trigger_rule: step.triggerRule,
      include: step.include,
      child_workflow: step.childWorkflow,
      command: step.command,
      command_file: step.commandFile,
      script: step.script,
      script_file: step.scriptFile,
      runtime: step.runtime,
      bash: step.bash,
      prompt: step.prompt,
      defined_in: step.definedIn,
      file: step.file,
    });
    stepRows(workflow, step.steps, step.path, into);
  }
  return into;
}

function subagentRows(workflow: string, steps: Step[]): SqlRow[] {
  return steps.flatMap((step) => [
    ...step.agents.map((agent) => ({
      workflow,
      step_path: step.path,
      name: agent.name,
      description: agent.description,
      prompt: agent.prompt,
      instruction_file: agent.instructionFile,
    })),
    ...subagentRows(workflow, step.steps),
  ]);
}

/** One row per distinct edge: `mc.arch_edges` keys a row by workflow and both paths, so a repeated `depends_on` entry is one edge. */
function edgeRows(workflow: string, edges: { from: string; to: string }[]): SqlRow[] {
  const distinct = new Map(edges.map((e) => [JSON.stringify([e.from, e.to]), e]));
  return [...distinct.values()].map((e) => ({ workflow, from_path: e.from, to_path: e.to }));
}

export function archRows(pack: PackVersion): ArchRows {
  const { workflows } = pack;
  return {
    arch_workflows: workflows.map((w) => ({
      name: w.name,
      description: w.description,
      model: w.model,
      file: w.file,
      yaml: w.yaml,
    })),
    arch_steps: workflows.flatMap((w) => stepRows(w.name, w.steps, null, [])),
    arch_edges: workflows.flatMap((w) => edgeRows(w.name, w.edges)),
    arch_texts: [...pack.commands, ...pack.sharedDocs].map((c) => ({ path: c.path, text: c.text })),
    arch_scripts: pack.scripts.map((s) => ({ path: s.path, text: s.text })),
    arch_subagents: workflows.flatMap((w) => subagentRows(w.name, w.steps)),
    arch_hooks: pack.hooks.map((h) => ({
      path: h.path,
      text: h.text,
      admitted_agents: h.admittedAgents,
    })),
  };
}

/**
 * Replaces the version's rows with `pack`'s, in the caller's transaction. A version's sources never
 * change, so a re-run of the same parser writes the same rows back, and `parsed_at` keeps the first
 * run's time. A change to what the parser records (such as `.shared` policy files in `arch_texts`)
 * reaches a stored version only by re-running this job for it: until then a diff between it and a
 * newer version lists every newly recorded file as added.
 */
async function storeVersion(tx: Tx, version: Version, parsedAt: Date): Promise<void> {
  const key = [version.archonSha, version.factorySha];
  await tx.query(
    'INSERT INTO mc.arch_versions (archon_sha, factory_sha, parsed_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
    [...key, parsedAt.toISOString()],
  );
  const rows = archRows(version.pack);
  for (const table of ARCH_TABLES) {
    await tx.query(`DELETE FROM mc.${table} WHERE archon_sha = $1 AND factory_sha = $2`, key);
    await tx.query(
      `INSERT INTO mc.${table} SELECT * FROM jsonb_populate_recordset(NULL::mc.${table}, $1::jsonb)`,
      [
        rows[table].map((row) => ({
          archon_sha: version.archonSha,
          factory_sha: version.factorySha,
          ...row,
        })),
      ],
    );
  }
}

/** The version's row count in `mc.arch_versions` and each table it owns rows in. */
async function rowCounts(tx: Tx, archonSha: string, factorySha: string) {
  const counts: Record<string, number> = {};
  for (const table of ['arch_versions', ...ARCH_TABLES]) {
    const [row] = await tx.query(
      `SELECT count(*)::int AS n FROM mc.${table} WHERE archon_sha = $1 AND factory_sha = $2`,
      [archonSha, factorySha],
    );
    counts[`mc.${table}`] = Number(row?.n);
  }
  return counts;
}

/** The full sha a local snapshot's commit file records, which must extend the sha given. */
function localSha(given: string, recorded: string | null, dir: string): string {
  if (recorded === null) {
    if (given.length === 40) return given;
    throw new Error(`${dir} records no commit: give the full 40-character sha`);
  }
  if (!recorded.startsWith(given)) throw new Error(`${dir} is at ${recorded}, not ${given}`);
  return recorded;
}

async function fetchInto(
  deps: Deps,
  root: string,
  repository: string,
  ref: string,
  dir: string,
): Promise<RemoteDirectory> {
  const remote = await readDirectoryAt(deps.fetch, repository, ref, dir);
  for (const file of remote.files ?? []) {
    const path = join(root, dir, file.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, file.bytes);
  }
  return remote;
}

/** Reads and parses the version from the local paths given, else from GitHub at the two shas. */
async function readVersion(
  deps: Deps,
  args: {
    archonSha: string;
    factorySha: string;
    archonPath?: string;
    factoryPath?: string;
    packagePath?: string;
  },
): Promise<Version> {
  const scratch = mkdtempSync(join(tmpdir(), 'mc-arch-'));
  try {
    let archon: { dir: string; sha: string | null };
    if (args.archonPath) {
      archon = { dir: join(resolve(deps.repoRoot, args.archonPath), 'sdlc'), sha: null };
    } else {
      const fetched = await fetchInto(deps, scratch, ARCHON_REPOSITORY, args.archonSha, PACK_DIR);
      if (fetched.files === null) {
        throw new Error(`${ARCHON_REPOSITORY} has no ${PACK_DIR}/ at ${fetched.sha}`);
      }
      archon = { dir: join(scratch, PACK_DIR), sha: fetched.sha };
    }

    // The factory side is the template's hooks and the factory package, each optional (the
    // factory's current commit has only the package), but not both missing.
    const localFactory = args.factoryPath !== undefined || args.packagePath !== undefined;
    let templateDir = join(scratch, TEMPLATE_DIR);
    const localPackageDir = args.packagePath ? resolve(deps.repoRoot, args.packagePath) : null;
    let packageDir = localPackageDir;
    let fetchedSha: string | null = null;
    if (localFactory) {
      if (args.factoryPath) templateDir = resolve(deps.repoRoot, args.factoryPath);
    } else {
      const hooks = await fetchInto(
        deps,
        scratch,
        FACTORY_REPOSITORY,
        args.factorySha,
        FACTORY_HOOKS_DIR,
      );
      const factoryPackage = await fetchInto(
        deps,
        scratch,
        FACTORY_REPOSITORY,
        args.factorySha,
        FACTORY_PACKAGE_DIR,
      );
      if (hooks.files === null && factoryPackage.files === null) {
        throw new Error(
          `${FACTORY_REPOSITORY} has neither ${FACTORY_HOOKS_DIR}/ nor ${FACTORY_PACKAGE_DIR}/ at ${hooks.sha}`,
        );
      }
      fetchedSha = hooks.sha;
      if (factoryPackage.files !== null) packageDir = join(scratch, FACTORY_PACKAGE_DIR);
    }
    // The parser reads a missing directory as an empty one, which would replace the version's rows
    // with nothing. GitHub reads report a missing directory; local paths are checked here.
    if (!existsSync(archon.dir)) throw new Error(`no pack at ${archon.dir}`);
    if (args.factoryPath && !existsSync(join(templateDir, HOOKS_DIR))) {
      throw new Error(`no ${HOOKS_DIR} under ${templateDir}`);
    }
    if (localPackageDir && !existsSync(localPackageDir)) {
      throw new Error(`no factory package at ${localPackageDir}`);
    }
    const pack = parseVersion(archon.dir, packageDir, templateDir);
    const local: string[] = [];
    if (args.factoryPath) local.push(localSha(args.factorySha, pack.factoryCommit, templateDir));
    if (localPackageDir) {
      local.push(localSha(args.factorySha, pack.packageCommit, localPackageDir));
    }
    const [first, second] = local;
    if (second !== undefined && first !== second) {
      throw new Error(`the template is at ${first} and the factory package at ${second}`);
    }
    return {
      archonSha: archon.sha ?? localSha(args.archonSha, pack.archonCommit, archon.dir),
      factorySha: fetchedSha ?? first ?? args.factorySha,
      pack,
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function parseCli(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      main: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      'archon-path': { type: 'string' },
      'factory-path': { type: 'string' },
      'package-path': { type: 'string' },
    },
  });
  if (values.help) return { help: true as const };
  const [archonSha, factorySha, ...extra] = positionals;
  if (!archonSha || !factorySha || extra.length > 0) {
    throw new Error('give an Archon sha and a factory sha');
  }
  for (const sha of [archonSha, factorySha]) {
    if (!SHA.test(sha)) throw new Error(`${sha} is not a commit sha`);
  }
  for (const flag of ['archon-path', 'factory-path', 'package-path'] as const) {
    if (values[flag] === '') throw new Error(`--${flag} needs a path`);
  }
  return {
    target: values.main ? ('main' as const) : ('check' as const),
    archonSha,
    factorySha,
    archonPath: values['archon-path'],
    factoryPath: values['factory-path'],
    packagePath: values['package-path'],
  };
}

export const main: Main = async (argv, deps) => {
  let parsed: ReturnType<typeof parseCli>;
  try {
    parsed = parseCli(argv);
  } catch (error) {
    deps.err(error instanceof Error ? `${error.message}\n${USAGE}` : USAGE);
    return 2;
  }
  if ('help' in parsed) {
    deps.out(USAGE);
    return 0;
  }
  const { target, ...args } = parsed;
  return failing(deps, async () => {
    const url = await guardedDatabaseUrl(deps, target);
    if (target === 'main' && !deps.confirmOwner(deps.env.NEON_PROJECT_ID ?? '')) {
      throw new Error('arch:parse:main is for the owner, at a terminal');
    }
    const version = await readVersion(deps, args);
    const db = deps.openDb(url);
    try {
      let counts: Record<string, number> = {};
      await db.transaction(async (tx) => {
        await storeVersion(tx, version, deps.now());
        counts = await rowCounts(tx, version.archonSha, version.factorySha);
      });
      deps.out(`archon ${version.archonSha} factory ${version.factorySha}`);
      for (const [table, n] of Object.entries(counts)) deps.out(`${table} ${n}`);
    } finally {
      await db.close();
    }
  });
};

if (import.meta.main) await runCli(main);
