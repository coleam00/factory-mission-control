import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { HOOKS_DIR, loadRefusal, type PackVersion, parsePack, type Step } from '../parsers/pack';
import { type Deps, failing, guardedDatabaseUrl, type Main, runCli } from './lib/cli';
import type { Row, Tx } from './lib/db';
import { readDirectoryAt } from './lib/github';

// The architecture job (PRD 11.4): one version's pack and factory template, parsed and stored as
// that version's architecture rows, with whether Archon would refuse to load the pack and why. A
// version is keyed by full commit shas, whichever form the
// command was given.

export const ARCHON_REPOSITORY = 'coleam00/Archon';
export const PACK_DIR = '.archon/workflows/sdlc';
export const FACTORY_REPOSITORY = 'coleam00/ai-software-factory';
const TEMPLATE_DIR = 'template';
/** Only the part of the template the parser reads, so no holdout scenario file is ever fetched. */
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
type ArchTable = (typeof ARCH_TABLES)[number];

const USAGE =
  'usage: bun run arch:parse <archon-sha> <factory-sha> [--archon-path <dir holding sdlc/>] [--factory-path <template dir>] | bun run arch:parse:main ... (the owner, at a terminal)';

const SHA = /^[0-9a-f]{7,40}$/;

interface Version {
  archonSha: string;
  factorySha: string;
  pack: PackVersion;
  /** Why Archon would refuse to load the pack, or null when it would load it. */
  refusal: string | null;
}

type ArchRows = Record<ArchTable, Row[]>;

/** Each workflow's expanded tree in parser order: a step, then its children, then its next sibling. */
function stepRows(workflow: string, steps: Step[], parent: string | null, into: Row[]): Row[] {
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

function subagentRows(workflow: string, steps: Step[]): Row[] {
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
    arch_edges: workflows.flatMap((w) =>
      w.edges.map((e) => ({ workflow: w.name, from_path: e.from, to_path: e.to })),
    ),
    arch_texts: pack.commands.map((c) => ({ path: c.path, text: c.text })),
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
 * change, so a re-run writes the same rows back, and `parsed_at` keeps the first run's time. The
 * refusal is rewritten, so a re-run records it for a version parsed before the job judged one.
 */
async function storeVersion(tx: Tx, version: Version, parsedAt: Date): Promise<void> {
  const key = [version.archonSha, version.factorySha];
  await tx.query(
    `INSERT INTO mc.arch_versions (archon_sha, factory_sha, parsed_at, refusal) VALUES ($1, $2, $3, $4)
     ON CONFLICT (archon_sha, factory_sha) DO UPDATE SET refusal = EXCLUDED.refusal`,
    [...key, parsedAt.toISOString(), version.refusal],
  );
  const rows = archRows(version.pack);
  for (const table of ARCH_TABLES) {
    await tx.query(`DELETE FROM mc.${table} WHERE archon_sha = $1 AND factory_sha = $2`, key);
    // Bound inside an object: Bun would send a bare array as a Postgres array, not jsonb.
    await tx.query(
      `INSERT INTO mc.${table} SELECT * FROM jsonb_populate_recordset(NULL::mc.${table}, $1::jsonb -> 'rows')`,
      [
        {
          rows: rows[table].map((row) => ({
            archon_sha: version.archonSha,
            factory_sha: version.factorySha,
            ...row,
          })),
        },
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
): Promise<string> {
  const remote = await readDirectoryAt(deps.fetch, repository, ref, dir);
  for (const file of remote.files) {
    const path = join(root, dir, file.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, file.bytes);
  }
  return remote.sha;
}

/** Reads and parses the version from the local paths given, else from GitHub at the two shas. */
async function readVersion(
  deps: Deps,
  args: { archonSha: string; factorySha: string; archonPath?: string; factoryPath?: string },
): Promise<Version> {
  const scratch = mkdtempSync(join(tmpdir(), 'mc-arch-'));
  try {
    const archon = args.archonPath
      ? { dir: join(resolve(deps.repoRoot, args.archonPath), 'sdlc'), sha: null }
      : {
          dir: join(scratch, PACK_DIR),
          sha: await fetchInto(deps, scratch, ARCHON_REPOSITORY, args.archonSha, PACK_DIR),
        };
    const factory = args.factoryPath
      ? { dir: resolve(deps.repoRoot, args.factoryPath), sha: null }
      : {
          dir: join(scratch, TEMPLATE_DIR),
          sha: await fetchInto(
            deps,
            scratch,
            FACTORY_REPOSITORY,
            args.factorySha,
            FACTORY_HOOKS_DIR,
          ),
        };
    // The parser reads a missing directory as an empty one, which would replace the version's rows
    // with nothing. GitHub reads already refuse a missing directory; local paths are checked here.
    if (!existsSync(archon.dir)) throw new Error(`no pack at ${archon.dir}`);
    if (!existsSync(join(factory.dir, HOOKS_DIR))) {
      throw new Error(`no ${HOOKS_DIR} under ${factory.dir}`);
    }
    const pack = parsePack(archon.dir, factory.dir);
    return {
      archonSha: archon.sha ?? localSha(args.archonSha, pack.archonCommit, archon.dir),
      factorySha: factory.sha ?? localSha(args.factorySha, pack.factoryCommit, factory.dir),
      pack,
      refusal: loadRefusal(pack.workflows),
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
  return {
    target: values.main ? ('main' as const) : ('check' as const),
    archonSha,
    factorySha,
    archonPath: values['archon-path'],
    factoryPath: values['factory-path'],
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
      if (version.refusal !== null) deps.out(`refused: ${version.refusal}`);
      for (const [table, n] of Object.entries(counts)) deps.out(`${table} ${n}`);
    } finally {
      await db.close();
    }
  });
};

if (import.meta.main) await runCli(main);
