import { placeAddress } from './places';
import { recorded } from './version-strip';

/** One row of `db/queries/step-detail.sql`: a node of a workflow's expanded tree. */
export interface StepRow {
  /** The pin of the version the row is from, null for a version no pin names (the queue pack's). */
  pin: string | null;
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
  child_workflow: string | null;
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

/** What the step screen's Kind fact says: the include or child workflow a node names, else its kind. */
export function kindLabel(step: StepRow): string {
  if (step.include !== null) return `include ${step.include}`;
  if (step.child_workflow !== null) return `workflow ${step.child_workflow}`;
  return step.kind;
}

/** A node a place passes through on its way down: where it sits in the place, and its row. */
export interface Enclosing {
  path: string;
  row: StepRow;
}

/** The step at one place, and the include and loop nodes enclosing it, outermost first. */
export interface Placed {
  step: StepRow;
  around: Enclosing[];
}

/**
 * The step a place names: `path` is Archon's step id with `__` read as `/`, so it runs through
 * includes into the declared rows of the workflow each one includes. A copy repeats its
 * definition, which is why the declared rows alone answer for every place.
 */
export function placeOf(
  rows: readonly StepRow[],
  workflow: string,
  path: string,
): Placed | undefined {
  const segments = path.split('/');
  const around: Enclosing[] = [];
  let declaring = workflow;
  let within = '';
  for (const [i, segment] of segments.entries()) {
    within = within === '' ? segment : `${within}/${segment}`;
    const row = rows.find((r) => r.workflow === declaring && r.path === within);
    if (row === undefined) return undefined;
    if (i === segments.length - 1) return { step: row, around };
    if (row.include !== null) {
      declaring = row.include;
      within = '';
    } else if (row.kind !== 'loop_group') {
      return undefined;
    }
    around.push({ path: segments.slice(0, i + 1).join('/'), row });
  }
  return undefined;
}

/** Whether some node of these rows includes `workflow`, so nothing runs it on its own. */
export function isIncluded(rows: readonly StepRow[], workflow: string): boolean {
  return rows.some((row) => row.include === workflow);
}

/** One place a step runs at: a step of a workflow nothing includes. */
export interface Place {
  workflow: string;
  path: string;
}

/**
 * Every place the step declared at `workflow` and `path` runs at, by top-level workflow and then
 * in declaration order. A workflow nothing includes is its own only place.
 */
export function placesOf(rows: readonly StepRow[], workflow: string, path: string): Place[] {
  const includers = rows.filter((row) => row.include === workflow);
  if (includers.length === 0) return [{ workflow, path }];
  const places = includers.flatMap((row) => placesOf(rows, row.workflow, `${row.path}/${path}`));
  const key = (place: Place): number[] => {
    const placed = placeOf(rows, place.workflow, place.path);
    return placed === undefined
      ? []
      : [...placed.around.map((a) => a.row.position), placed.step.position];
  };
  return places
    .map((place) => ({ place, key: key(place) }))
    .sort((a, b) => a.place.workflow.localeCompare(b.place.workflow) || compare(a.key, b.key))
    .map((entry) => entry.place);
}

function compare(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return (a[i] ?? 0) - (b[i] ?? 0);
  }
  return a.length - b.length;
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

/** One row of `db/queries/step-nesting.sql`: a node beneath the step. */
export interface NestingRow {
  path: string;
  position: number;
  step_id: string;
  kind: string;
}

/** The address parameter that pins a screen to a version. */
export const AT_PARAM = 'at';

/** Where every step's screen in `factory` lives. */
export function stepsPrefix(factory: string): string {
  return `${placeAddress(factory, '')}/steps/`;
}

/**
 * A step's screen in `factory`, at the version pinned `at` when one is given. A nested path's `/` is
 * encoded, and react-router decodes it back.
 */
export function stepHref(
  factory: string,
  workflow: string,
  path: string,
  at?: string | null,
): string {
  const href = `${stepsPrefix(factory)}${encodeURIComponent(workflow)}/${encodeURIComponent(path)}`;
  return at ? `${href}?${AT_PARAM}=${encodeURIComponent(at)}` : href;
}

/**
 * Where a step screen was opened from: the address to return to, how the breadcrumb names it, and
 * the map card to select there. The opener passes it as history state, `{ from }`.
 */
export interface StepOrigin {
  href: string;
  label: string;
  card?: string;
}

/** The history state an opener passes so the step screen knows where it was opened from. */
export function stepOriginState(from: StepOrigin): { from: StepOrigin } {
  return { from };
}

/** The origin a navigation's history state carries, when the opener passed one. */
export function stepOriginOf(state: unknown): StepOrigin | undefined {
  if (typeof state !== 'object' || state === null || !('from' in state)) return undefined;
  const from = state.from;
  if (typeof from !== 'object' || from === null) return undefined;
  if (!('href' in from) || typeof from.href !== 'string') return undefined;
  if (!('label' in from) || typeof from.label !== 'string') return undefined;
  const card = 'card' in from && typeof from.card === 'string' ? from.card : undefined;
  return card === undefined
    ? { href: from.href, label: from.label }
    : { href: from.href, label: from.label, card };
}

/** The nodes beneath `path`, each opening its place in `workflow` at the version pinned `at`. */
export function nesting(
  rows: readonly NestingRow[],
  factory: string,
  workflow: string,
  path: string,
  at?: string | null,
): { label: string; depth: number; kind: string; href: string }[] {
  return [...rows]
    .sort((x, y) => x.position - y.position)
    .map((row) => {
      const label = row.path.slice(path.length + 1);
      return {
        label,
        depth: label.split('/').length - 1,
        kind: row.kind,
        href: stepHref(factory, workflow, row.path, at),
      };
    });
}

/**
 * One row of `db/queries/step-versions.sql`: a pin with architecture, or on a factory on the queues
 * the current version when no pin names it (its Archon commit, `committed_at` its parse time), and
 * whether it is the version the step screen shows without one in its address.
 */
export interface StepVersionRow {
  sha: string;
  reason: string | null;
  committed_at: Date;
  is_current: boolean;
}

export interface StepVersion {
  sha: string;
  /** The pin's (or the unpinned current version's Archon commit's) first 8 characters and its date. */
  label: string;
  /** The pin's reason, or `not recorded` for a bare pin or for the current version no pin names. */
  reason: string;
  current: boolean;
}

/** The versions the step screen can open, newest first. */
export function stepVersions(rows: readonly StepVersionRow[]): StepVersion[] {
  return [...rows]
    .sort(
      (a, b) => b.committed_at.getTime() - a.committed_at.getTime() || a.sha.localeCompare(b.sha),
    )
    .map((row) => ({
      sha: row.sha,
      label: `${row.sha.slice(0, 8)} ${row.committed_at.toISOString().slice(0, 10)}`,
      reason: recorded(row.reason),
      current: row.is_current,
    }));
}

/**
 * The version the map link of a step screen carries: the map resolves only a pin, so a screen
 * addressed by an Archon commit links the map by the row's own pin, or without one when it has none.
 */
export function mapAt(at: string | null, found: Pick<StepRow, 'pin'> | undefined): string | null {
  return found ? found.pin : at;
}

/** The version the step screen shows, in a sentence: the one pinned `at`, else the current one. */
export function versionName(at: string | null): string {
  return at === null ? 'the current version' : `version ${at.slice(0, 8)}`;
}
