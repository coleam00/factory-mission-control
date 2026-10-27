import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';

// Parses one version of the factory: the pinned Archon workflow pack and the factory template's
// hooks. Every value comes from a file under the two input directories (PRD invariant 6); nothing
// here touches the network, and the template is read only under `.factory/hooks/`, so a holdout
// scenario file is never opened.

export type StepKind =
  | 'include'
  | 'loop_group'
  | 'loop'
  | 'approval'
  | 'command'
  | 'script'
  | 'bash'
  | 'prompt';

export interface Subagent {
  name: string;
  description: string | null;
  prompt: string | null;
  /** Pack-relative path of the command file named for the agent, when the pack has one. */
  instructionFile: string | null;
  instructionText: string | null;
}

export interface Step {
  id: string;
  /** Unique within its root workflow: include and loop-group ancestors joined by `/`. */
  path: string;
  kind: StepKind;
  /** The YAML comment directly above the node, else (for an include) the included workflow's. */
  description: string | null;
  /** The agent's model tier, defaulting to the workflow's; null for a node that runs no agent. */
  model: string | null;
  when: string | null;
  dependsOn: string[];
  triggerRule: string | null;
  /** The workflow this node includes, by name. */
  include: string | null;
  command: string | null;
  commandFile: string | null;
  commandText: string | null;
  /** A script name, or the inline source when the node carries one. */
  script: string | null;
  scriptFile: string | null;
  runtime: string | null;
  bash: string | null;
  prompt: string | null;
  agents: Subagent[];
  /** The workflow (by name) and pack-relative file whose YAML declares this node. */
  definedIn: string;
  file: string;
  /** The expanded include, or the loop group's nodes, in declaration order. */
  steps: Step[];
}

export interface Edge {
  from: string;
  to: string;
}

export interface Workflow {
  name: string;
  description: string | null;
  model: string | null;
  file: string;
  yaml: string;
  steps: Step[];
  /** Every `depends_on` in the expanded tree, as step paths. */
  edges: Edge[];
}

export interface TextFile {
  path: string;
  text: string;
}

export interface Hook extends TextFile {
  /** The agents the hook lets through, as the hook file names them. */
  admittedAgents: string[];
}

export interface PackVersion {
  archonCommit: string | null;
  factoryCommit: string | null;
  workflows: Workflow[];
  commands: TextFile[];
  scripts: TextFile[];
  hooks: Hook[];
}

interface Source {
  name: string;
  file: string;
  dir: string;
  yaml: string;
  lines: string[];
  doc: Record<string, unknown>;
}

type Node = Record<string, unknown>;

const AGENT_KINDS = new Set<StepKind>(['command', 'loop', 'prompt']);

/** The only directory of the factory template the parser reads. */
export const HOOKS_DIR = '.factory/hooks';

function slash(path: string): string {
  return path.replaceAll('\\', '/');
}

function list(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

function isDir(path: string): boolean {
  return statSync(path).isDirectory();
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/** A file's text with CRLF read as LF, so a version stores the same text from any checkout. */
function readText(path: string): string {
  return readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
}

function commit(...files: string[]): string | null {
  const found = files.find((file) => existsSync(file));
  return found ? readFileSync(found, 'utf8').trim() : null;
}

function filesUnder(dir: string): string[] {
  return list(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return isDir(path) ? filesUnder(path) : [path];
  });
}

function readSources(packDir: string): Source[] {
  const sources: Source[] = [];
  for (const entry of list(packDir)) {
    const dir = join(packDir, entry);
    if (entry.startsWith('.') || !isDir(dir)) continue;
    for (const file of list(dir)) {
      if (!file.endsWith('.yaml') && !file.endsWith('.yml')) continue;
      const path = join(dir, file);
      const yaml = readText(path);
      const doc = Bun.YAML.parse(yaml) as Record<string, unknown>;
      const name = str(doc.name);
      if (!name) throw new Error(`${slash(relative(packDir, path))} has no workflow name`);
      sources.push({
        name,
        file: slash(relative(packDir, path)),
        dir: entry,
        yaml,
        lines: yaml.split('\n'),
        doc,
      });
    }
  }
  return sources;
}

/** The comment block directly above `- id: <id>`, searching forward from the cursor. */
function commentAbove(source: Source, id: string, cursor: { line: number }): string | null {
  const pattern = new RegExp(
    `^(\\s*)- id:\\s*['"]?${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]?\\s*$`,
  );
  for (let at = cursor.line; at < source.lines.length; at++) {
    const match = pattern.exec(source.lines[at] ?? '');
    if (!match) continue;
    cursor.line = at + 1;
    const indent = match[1] ?? '';
    const block: string[] = [];
    for (let up = at - 1; up >= 0; up--) {
      const line = source.lines[up] ?? '';
      if (!line.startsWith(`${indent}#`)) break;
      block.unshift(line.slice(indent.length + 1).replace(/^ /, ''));
    }
    return block.length > 0 ? block.join('\n') : null;
  }
  return null;
}

function scriptFile(packDir: string, dir: string, name: string): string | null {
  const scripts = join(packDir, dir, 'scripts');
  const match = list(scripts).filter((file) => file.replace(/\.[^.]+$/, '') === name);
  if (match.length > 1) throw new Error(`${dir}/scripts has more than one script named ${name}`);
  return match[0] ? slash(relative(packDir, join(scripts, match[0]))) : null;
}

function kindOf(node: Node): StepKind {
  if (node.include !== undefined) return 'include';
  if (node.loop_group !== undefined) return 'loop_group';
  if (node.loop !== undefined) return 'loop';
  if (node.approval !== undefined) return 'approval';
  if (node.command !== undefined) return 'command';
  if (node.script !== undefined) return 'script';
  if (node.bash !== undefined) return 'bash';
  if (node.prompt !== undefined) return 'prompt';
  throw new Error(`node ${String(node.id)} has no kind Archon runs`);
}

export function parsePack(packDir: string, templateDir: string): PackVersion {
  const sources = readSources(packDir);
  const byName = new Map<string, Source>();
  for (const source of sources) {
    if (byName.has(source.name)) throw new Error(`two workflows are named ${source.name}`);
    byName.set(source.name, source);
  }

  const commands: TextFile[] = [];
  for (const entry of list(packDir)) {
    const dir = join(packDir, entry, 'commands');
    if (!isDir(join(packDir, entry))) continue;
    for (const file of list(dir)) {
      if (!file.endsWith('.md')) continue;
      const path = join(dir, file);
      commands.push({ path: slash(relative(packDir, path)), text: readText(path) });
    }
  }
  const commandText = new Map(commands.map((c) => [c.path, c.text]));

  const scripts: TextFile[] = [];
  for (const entry of list(packDir)) {
    const root = join(packDir, entry);
    if (!isDir(root)) continue;
    const files = entry === '.shared' ? filesUnder(root) : filesUnder(join(root, 'scripts'));
    for (const path of files) {
      if (path.endsWith('.md')) continue;
      scripts.push({ path: slash(relative(packDir, path)), text: readText(path) });
    }
  }

  function subagents(value: unknown): Subagent[] {
    if (!value || typeof value !== 'object') return [];
    return Object.entries(value as Record<string, Node>).map(([name, agent]) => {
      const instructionFile = commands.find((c) => basename(c.path) === `${name}.md`)?.path ?? null;
      return {
        name,
        description: str(agent.description),
        prompt: str(agent.prompt),
        instructionFile,
        instructionText: instructionFile ? (commandText.get(instructionFile) ?? null) : null,
      };
    });
  }

  function expand(
    source: Source,
    nodes: unknown,
    prefix: string,
    stack: string[],
    edges: Edge[],
    cursor: { line: number },
  ): Step[] {
    if (!Array.isArray(nodes)) return [];
    const scope = nodes as Node[];
    const steps: Step[] = [];
    for (const node of scope) {
      const id = str(node.id);
      if (!id) throw new Error(`${source.file} has a node with no id`);
      const path = `${prefix}${id}`;
      const kind = kindOf(node);
      const dependsOn = strings(node.depends_on);
      for (const dep of dependsOn) {
        if (!scope.some((other) => other.id === dep)) {
          throw new Error(`${source.file}: ${id} depends on ${dep}, which is not in its scope`);
        }
        edges.push({ from: `${prefix}${dep}`, to: path });
      }

      const comment = commentAbove(source, id, cursor);
      const loop = (node.loop ?? null) as Node | null;
      const command = str(node.command) ?? (loop ? str(loop.command) : null);
      let commandFile: string | null = null;
      if (command) {
        commandFile = `${source.dir}/commands/${command}.md`;
        if (!commandText.has(commandFile)) {
          throw new Error(`${source.file}: ${id} runs command ${command}, missing ${commandFile}`);
        }
      }
      const script = str(node.script);
      const inline = script !== null && /\s/.test(script);
      const resolvedScript = script && !inline ? scriptFile(packDir, source.dir, script) : null;
      if (script && !inline && !resolvedScript) {
        throw new Error(
          `${source.file}: ${id} runs script ${script}, not in ${source.dir}/scripts`,
        );
      }

      const include = str(node.include);
      let children: Step[] = [];
      let description = comment;
      if (include) {
        const included = byName.get(include);
        if (!included) throw new Error(`${source.file}: ${id} includes unknown ${include}`);
        if (stack.includes(include)) {
          throw new Error(`include cycle: ${[...stack, include].join(' -> ')}`);
        }
        description ??= str(included.doc.description);
        children = expand(included, included.doc.nodes, `${path}/`, [...stack, include], edges, {
          line: 0,
        });
      } else if (kind === 'loop_group') {
        const group = node.loop_group as Node;
        children = expand(source, group.nodes, `${path}/`, stack, edges, cursor);
      }

      steps.push({
        id,
        path,
        kind,
        description,
        model: AGENT_KINDS.has(kind) ? (str(node.model) ?? str(source.doc.model)) : null,
        when: str(node.when),
        dependsOn,
        triggerRule: str(node.trigger_rule),
        include,
        command,
        commandFile,
        commandText: commandFile ? (commandText.get(commandFile) ?? null) : null,
        script,
        scriptFile: resolvedScript,
        runtime: str(node.runtime),
        bash: str(node.bash),
        prompt: str(node.prompt),
        agents: subagents(node.agents),
        definedIn: source.name,
        file: source.file,
        steps: children,
      });
    }
    return steps;
  }

  const workflows = sources.map((source): Workflow => {
    const edges: Edge[] = [];
    const steps = expand(source, source.doc.nodes, '', [source.name], edges, { line: 0 });
    return {
      name: source.name,
      description: str(source.doc.description),
      model: str(source.doc.model),
      file: source.file,
      yaml: source.yaml,
      steps,
      edges,
    };
  });

  const hooks: Hook[] = filesUnder(join(templateDir, HOOKS_DIR)).map((path) => {
    const text = readText(path);
    return { path: slash(relative(templateDir, path)), text, admittedAgents: admitted(text) };
  });

  return {
    archonCommit: commit(join(packDir, 'ARCHON_COMMIT'), join(dirname(packDir), 'ARCHON_COMMIT')),
    factoryCommit: commit(join(templateDir, 'FACTORY_COMMIT')),
    workflows,
    commands,
    scripts,
    hooks,
  };
}

/** The agent names in a hook's `*_AGENTS = {...}` set, in the order the file lists them. */
function admitted(text: string): string[] {
  const names: string[] = [];
  for (const set of text.matchAll(/^[A-Z_]*AGENTS\s*=\s*[{[(]([^}\])]*)[}\])]/gm)) {
    for (const name of (set[1] ?? '').matchAll(/["']([^"']+)["']/g)) {
      if (name[1] && !names.includes(name[1])) names.push(name[1]);
    }
  }
  return names;
}
