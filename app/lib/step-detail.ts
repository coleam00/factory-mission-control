/** One row of `db/queries/step-detail.sql`: a node of a workflow's expanded tree. */
export interface StepRow {
  workflow: string;
  path: string;
  parent_path: string | null;
  position: number;
  step_id: string;
  kind: string;
  description: string | null;
  model: string | null;
  when_condition: string | null;
  depends_on: string[];
  trigger_rule: string | null;
  include: string | null;
  command_file: string | null;
  script: string | null;
  script_file: string | null;
  runtime: string | null;
  bash: string | null;
  prompt: string | null;
  defined_in: string;
  file: string;
}

/** One row of `db/queries/step-subagents.sql`: a subagent and one part of its instruction file. */
export interface SubagentRow {
  workflow: string;
  step_path: string;
  name: string;
  description: string | null;
  prompt: string | null;
  instruction_file: string | null;
  part: number;
  /** Null for an agent with no instruction file. */
  chunk: string | null;
}

/** One row of `db/queries/step-hooks.sql`: a hook, and one of a step's subagents it lets through. */
export interface HookRow {
  path: string;
  admitted_agents: string[];
  workflow: string;
  step_path: string;
  agent: string;
  description: string | null;
}

/** One part of a file in `step-prompt.sql`, `step-scripts.sql` or `step-yaml.sql`. */
export interface PartRow {
  path: string;
  part: number;
  chunk: string;
}

/** `step-yaml.sql` names a workflow's YAML by the workflow, and says which file it is. */
export interface YamlPartRow {
  name: string;
  file: string;
  part: number;
  chunk: string;
}

/** The step a URL names: its path within the workflow, as react-router decoded it. */
export function findStep(
  rows: readonly StepRow[],
  workflow: string,
  path: string,
): StepRow | undefined {
  return rows.find((row) => row.workflow === workflow && row.path === path);
}

/** The steps in the same scope that depend on `step`, in declaration order. */
export function dependents(rows: readonly StepRow[], step: StepRow): StepRow[] {
  return rows
    .filter(
      (row) =>
        row.workflow === step.workflow &&
        row.parent_path === step.parent_path &&
        row.depends_on.includes(step.step_id),
    )
    .sort((a, b) => a.position - b.position);
}

/** Each file whole, keyed by `key`: the queries split texts into ordered parts (REALTIME.md). */
export function joinParts<Row extends { part: number; chunk: string | null }>(
  rows: readonly Row[],
  key: (row: Row) => string,
): Map<string, string> {
  const files = new Map<string, Row[]>();
  for (const row of rows) files.set(key(row), [...(files.get(key(row)) ?? []), row]);
  return new Map(
    [...files].map(([name, parts]) => [
      name,
      parts
        .sort((a, b) => a.part - b.part)
        .map((p) => p.chunk ?? '')
        .join(''),
    ]),
  );
}

/** One row of `db/queries/step-nesting.sql`: a node beneath the step, or a place an include puts it. */
export interface NestingRow {
  relation: 'inside' | 'included_at';
  workflow: string;
  path: string;
  position: number;
  step_id: string;
  kind: string;
  /** The screen the row opens: a node's own screen, a place's the node it sits in. */
  open_workflow: string;
  open_path: string;
}

/** A step's screen. A nested path's `/` is encoded, and react-router decodes it back. */
export function stepHref(workflow: string, path: string): string {
  return `/steps/${encodeURIComponent(workflow)}/${encodeURIComponent(path)}`;
}

export interface Nesting {
  /** Every node beneath the step, by its path beneath it, in declaration order. */
  inside: { label: string; depth: number; kind: string; href: string }[];
  /** Every place an include puts the step, by workflow and path there. */
  includedAt: { workflow: string; path: string; href: string }[];
}

export function nesting(rows: readonly NestingRow[], step: StepRow): Nesting {
  const of = (relation: NestingRow['relation']) => rows.filter((row) => row.relation === relation);
  return {
    inside: of('inside')
      .sort((a, b) => a.position - b.position)
      .map((row) => {
        const label = row.path.slice(step.path.length + 1);
        return {
          label,
          depth: label.split('/').length - 1,
          kind: row.kind,
          href: stepHref(row.open_workflow, row.open_path),
        };
      }),
    includedAt: of('included_at')
      .sort((a, b) => a.workflow.localeCompare(b.workflow) || a.position - b.position)
      .map((row) => ({
        workflow: row.workflow,
        path: row.path,
        href: stepHref(row.open_workflow, row.open_path),
      })),
  };
}
