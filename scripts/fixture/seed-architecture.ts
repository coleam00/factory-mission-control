import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type PackVersion, parsePack, type Step } from '../../parsers/pack';
import { insert, lit, type SqlRow } from './sql';

type Edit = { file: string } & ({ find: string; replace: string } | { append: string });

/**
 * V2's pack is V1's with these edits, applied verbatim (PRD 4.2 architecture diff): one step
 * removed (`briefs`, with the comment above it), one added (`tally`), one prompt and one subagent
 * changed. Each `find` must occur exactly once in its file.
 */
export const V2_EDITS: Edit[] = [
  {
    file: 'loop/archon-loop.yaml',
    find: `  # Black-box check: runs the app against the contract and the holdout before it
  # reads any diff, on the pull request merged with the current default branch. Its
  # report is structured, so the evidence check and the merge gate read lines, not prose.
  # The holdout verifier's instructions are a command file in this pack; an inline agent
  # cannot reach the pack, so this copies them where the agent's prompt points.
  - id: briefs
    script: briefs
    runtime: bun
    depends_on: [subject]

`,
    replace: '',
  },
  {
    file: 'loop/archon-loop.yaml',
    find: '    depends_on: [subject, briefs]\n',
    replace: '    depends_on: [subject]\n',
  },
  {
    file: 'loop/archon-loop.yaml',
    append: `
  # Count the lap in the factory's own log once the work item is free.
  - id: tally
    bash: "echo lap done"
    depends_on: [release]
    trigger_rule: all_done
`,
  },
  {
    file: 'loop/commands/loop-review.md',
    append: '\nName the file of every disposition in its reason.\n',
  },
  {
    file: 'manager/archon-manager.yaml',
    find: "Writes and tightens the project's holdout scenarios",
    replace: "Writes the project's holdout scenarios",
  },
];

/** Copies `from` to `to` with CRLF made LF, so a Windows checkout parses what CI parses. */
function copyLf(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  for (const name of readdirSync(from)) {
    const source = join(from, name);
    const target = join(to, name);
    if (statSync(source).isDirectory()) copyLf(source, target);
    else writeFileSync(target, readFileSync(source, 'utf8').replaceAll('\r\n', '\n'));
  }
}

function applyEdit(sdlc: string, edit: Edit): void {
  const path = join(sdlc, edit.file);
  const text = readFileSync(path, 'utf8');
  if ('append' in edit) {
    writeFileSync(path, text + edit.append);
    return;
  }
  const found = text.split(edit.find).length - 1;
  if (found !== 1) throw new Error(`${edit.file}: expected one match for an edit, found ${found}`);
  writeFileSync(
    path,
    text.replace(edit.find, () => edit.replace),
  );
}

/** V1, parsed from `fixtures/pack/` and `fixtures/factory-template/`, and V2, V1 with V2_EDITS. */
export function parseVersions(repoRoot: string): { v1: PackVersion; v2: PackVersion } {
  const scratch = mkdtempSync(join(tmpdir(), 'mc-seed-'));
  try {
    const parse = (name: string, edit: boolean) => {
      const dir = join(scratch, name);
      copyLf(join(repoRoot, 'fixtures', 'pack'), join(dir, 'pack'));
      copyLf(join(repoRoot, 'fixtures', 'factory-template'), join(dir, 'factory-template'));
      const sdlc = join(dir, 'pack', 'sdlc');
      if (edit) for (const change of V2_EDITS) applyEdit(sdlc, change);
      return parsePack(sdlc, join(dir, 'factory-template'));
    };
    return { v1: parse('v1', false), v2: parse('v2', true) };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** One architecture table: its rows without the version key, and the columns that key a row. */
type Table = { name: string; key: string[]; rows: SqlRow[] };

function steps(workflow: string, all: Step[], parent: string | null, out: SqlRow[]): void {
  for (const step of all) {
    out.push({
      workflow,
      path: step.path,
      parent_path: parent,
      position: out.length,
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
    steps(workflow, step.steps, step.path, out);
  }
}

function subagents(workflow: string, all: Step[], out: SqlRow[]): void {
  for (const step of all) {
    for (const agent of step.agents) {
      out.push({
        workflow,
        step_path: step.path,
        name: agent.name,
        description: agent.description,
        prompt: agent.prompt,
        instruction_file: agent.instructionFile,
      });
    }
    subagents(workflow, step.steps, out);
  }
}

/** The mc.arch_* rows of one parsed version (the mapping is this seed's, until 12 item 9's job). */
function tables(version: PackVersion): Table[] {
  const stepRows: SqlRow[] = [];
  const subagentRows: SqlRow[] = [];
  const edgeRows = new Map<string, SqlRow>();
  for (const workflow of version.workflows) {
    const own: SqlRow[] = [];
    steps(workflow.name, workflow.steps, null, own);
    stepRows.push(...own);
    subagents(workflow.name, workflow.steps, subagentRows);
    for (const edge of workflow.edges) {
      edgeRows.set(JSON.stringify([workflow.name, edge.from, edge.to]), {
        workflow: workflow.name,
        from_path: edge.from,
        to_path: edge.to,
      });
    }
  }
  return [
    {
      name: 'mc.arch_workflows',
      key: ['name'],
      rows: version.workflows.map((w) => ({
        name: w.name,
        description: w.description,
        model: w.model,
        file: w.file,
        yaml: w.yaml,
      })),
    },
    { name: 'mc.arch_steps', key: ['workflow', 'path'], rows: stepRows },
    {
      name: 'mc.arch_edges',
      key: ['workflow', 'from_path', 'to_path'],
      rows: [...edgeRows.values()],
    },
    {
      name: 'mc.arch_texts',
      key: ['path'],
      rows: version.commands.map((c) => ({ path: c.path, text: c.text })),
    },
    {
      name: 'mc.arch_scripts',
      key: ['path'],
      rows: version.scripts.map((s) => ({ path: s.path, text: s.text })),
    },
    { name: 'mc.arch_subagents', key: ['workflow', 'step_path', 'name'], rows: subagentRows },
    {
      name: 'mc.arch_hooks',
      key: ['path'],
      rows: version.hooks.map((h) => ({
        path: h.path,
        text: h.text,
        admitted_agents: h.admittedAgents,
      })),
    },
  ];
}

export type ArchKey = { archon_sha: string; factory_sha: string; parsed_at: string };

const keyOf = (table: Table, row: SqlRow) => JSON.stringify(table.key.map((column) => row[column]));

const versionMatch = (key: ArchKey) =>
  `archon_sha = ${lit(key.archon_sha)} AND factory_sha = ${lit(key.factory_sha)}`;

/** V1's rows in full, then V2's as a copy of V1's with the rows V2_EDITS changed replaced. */
export function architectureSql(
  v1: { version: PackVersion; key: ArchKey },
  v2: { version: PackVersion; key: ArchKey },
): string[] {
  const versionKey = ({ archon_sha, factory_sha }: ArchKey) => ({ archon_sha, factory_sha });
  const out = [insert('mc.arch_versions', v1.key)];
  const before = tables(v1.version);
  for (const table of before) {
    for (const row of table.rows) out.push(insert(table.name, { ...versionKey(v1.key), ...row }));
  }

  out.push('', `-- V2: V1's rows copied, then every row V2_EDITS changed replaced.`);
  out.push(insert('mc.arch_versions', v2.key));
  for (const [index, table] of tables(v2.version).entries()) {
    const old = before[index];
    if (old?.name !== table.name) throw new Error(`table order differs at ${table.name}`);
    const columns = Object.keys(old.rows[0] ?? table.rows[0] ?? {});
    out.push(
      `INSERT INTO ${table.name} (archon_sha, factory_sha, ${columns.join(', ')}) SELECT ${lit(v2.key.archon_sha)}, ${lit(v2.key.factory_sha)}, ${columns.join(', ')} FROM ${table.name} WHERE ${versionMatch(v1.key)};`,
    );
    const oldRows = new Map(old.rows.map((row) => [keyOf(old, row), JSON.stringify(row)]));
    const newRows = new Map(table.rows.map((row) => [keyOf(table, row), row]));
    for (const [key, row] of oldRows) {
      const now = newRows.get(key);
      if (now !== undefined && JSON.stringify(now) === row) continue;
      const where = table.key.map((column, i) => `${column} = ${lit(JSON.parse(key)[i])}`);
      out.push(
        `DELETE FROM ${table.name} WHERE ${versionMatch(v2.key)} AND ${where.join(' AND ')};`,
      );
    }
    for (const [key, row] of newRows) {
      if (oldRows.get(key) === JSON.stringify(row)) continue;
      out.push(insert(table.name, { ...versionKey(v2.key), ...row }));
    }
  }
  return out;
}
