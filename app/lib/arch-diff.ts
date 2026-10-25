/**
 * The architecture diff between two versions, from `db/queries/arch-diff.sql`'s rows: every
 * architecture row of every version the factory ran, each with an md5 of what it says. Pure, no
 * React.
 */

export const KINDS = ['workflow', 'step', 'prompt', 'subagent'] as const;
export type Kind = (typeof KINDS)[number];

export interface ArchDiffRow {
  digest: string;
  kind: Kind;
  workflow: string | null;
  /** A step's id, or the path of the step a subagent belongs to; null otherwise. */
  step: string | null;
  /** A workflow's name, a step's path, a prompt file's path or a subagent's name. */
  name: string;
  content: string;
  depends_on: string[];
}

export interface Item {
  kind: Kind;
  workflow: string | null;
  step: string | null;
  name: string;
}

export interface KindDiff {
  added: Item[];
  removed: Item[];
  changed: Item[];
}

export type ArchDiff = Record<Kind, KindDiff>;

export type DiffResult =
  | { status: 'compared'; diff: ArchDiff; changes: number }
  /** The versions named that have no architecture rows: not run here, or not parsed yet. */
  | { status: 'unrecorded'; digests: string[] };

/** What identifies a row within one version; a step's id is not unique, its path is. */
const keyOf = (row: ArchDiffRow): string =>
  JSON.stringify([row.kind, row.workflow, row.kind === 'step' ? null : row.step, row.name]);

const item = ({ kind, workflow, step, name }: ArchDiffRow): Item => ({
  kind,
  workflow,
  step: kind === 'subagent' ? step : null,
  name,
});

const byKey = (rows: readonly ArchDiffRow[], digest: string) =>
  new Map(rows.filter((r) => r.digest === digest).map((r) => [keyOf(r), r]));

const order = (a: Item, b: Item): number =>
  (a.workflow ?? '').localeCompare(b.workflow ?? '') ||
  (a.step ?? '').localeCompare(b.step ?? '') ||
  a.name.localeCompare(b.name);

/**
 * What changed from version `a` to `b`. A row is added or removed by its key, and changed when
 * its content differs. A step's `depends_on` changes it too, except for the ids of steps added or
 * removed in the same workflow: dropping a step drops it from its dependants, and the diff already
 * says the step went.
 */
export function diffVersions(rows: readonly ArchDiffRow[], a: string, b: string): DiffResult {
  const before = byKey(rows, a);
  const after = byKey(rows, b);
  const unrecorded = [...new Set([a, b])].filter((digest) => !rows.some((r) => r.digest === digest));
  if (unrecorded.length > 0) return { status: 'unrecorded', digests: unrecorded };

  const none = (): KindDiff => ({ added: [], removed: [], changed: [] });
  const diff: ArchDiff = { workflow: none(), step: none(), prompt: none(), subagent: none() };
  const comingAndGoing = new Set<string>();
  for (const [key, row] of after) {
    if (before.has(key)) continue;
    diff[row.kind].added.push(item(row));
    if (row.kind === 'step') comingAndGoing.add(JSON.stringify([row.workflow, row.step]));
  }
  for (const [key, row] of before) {
    if (after.has(key)) continue;
    diff[row.kind].removed.push(item(row));
    if (row.kind === 'step') comingAndGoing.add(JSON.stringify([row.workflow, row.step]));
  }
  const dependencies = (row: ArchDiffRow) =>
    row.depends_on
      .filter((id) => !comingAndGoing.has(JSON.stringify([row.workflow, id])))
      .sort()
      .join('\n');
  for (const [key, row] of after) {
    const was = before.get(key);
    if (was === undefined) continue;
    if (was.content !== row.content || dependencies(was) !== dependencies(row)) {
      diff[row.kind].changed.push(item(row));
    }
  }

  let changes = 0;
  for (const kind of KINDS) {
    for (const list of Object.values(diff[kind])) {
      list.sort(order);
      changes += list.length;
    }
  }
  return { status: 'compared', diff, changes };
}

/** How an item reads on screen: its workflow and step, where it has them, then its name. */
export function itemLabel({ kind, workflow, step, name }: Item): string {
  if (kind === 'workflow' || workflow === null) return name;
  return [workflow, step, name].filter((part) => part !== null).join(' · ');
}
