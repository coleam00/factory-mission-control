/**
 * The architecture diff between two versions, from `db/queries/arch-diff.sql`'s rows. Pure, no
 * React.
 */

export const KINDS = ['workflow', 'step', 'prompt', 'subagent'] as const;
export type Kind = (typeof KINDS)[number];

/**
 * One version's rows of one kind in one workflow (null for workflows and prompts, which are the
 * pack's). Each entry is tab-separated: a workflow's name, a step's path, a prompt file's path or
 * a subagent's step path and name, then the first 12 hex digits of the md5 of what the row says.
 * An `edge` entry is a step dependency, `from_path` then `to_path`. The query aggregates and
 * hashes because the first snapshot is timed: one row per architecture row, in full, took
 * hundreds of milliseconds longer to arrive. A `version` row, with no entries, names one of this
 * factory's versions (its mc.versions rows and its archon-loop lap digests, as the scorecard reads
 * them), architecture or not.
 */
export interface ArchDiffRow {
  digest: string;
  kind: Kind | 'edge' | 'version';
  workflow: string | null;
  /** A `version` row's first run (its earliest lap or mc.versions row); null on every other kind. */
  first_run_at?: Date | null;
  entries: string[];
}

export interface Item {
  kind: Kind;
  workflow: string | null;
  /** The path of the step a subagent belongs to; null for every other kind. */
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
  /** The digests named that are not one of this factory's versions. */
  | { status: 'not-found'; digests: string[] }
  /** The versions named that have no architecture rows: not parsed yet. */
  | { status: 'unrecorded'; digests: string[] };

interface Entry {
  item: Item;
  content: string;
}

/** One version's items by key, and each step's dependencies by its key. */
function versionOf(
  rows: readonly ArchDiffRow[],
  digest: string,
): { items: Map<string, Entry>; dependencies: Map<string, string[]> } {
  const items = new Map<string, Entry>();
  const dependencies = new Map<string, string[]>();
  for (const { kind, workflow, entries } of rows.filter((r) => r.digest === digest)) {
    if (kind === 'version') continue;
    for (const entry of entries) {
      const fields = entry.split('\t');
      if (kind === 'edge') {
        const [from, to] = fields;
        const key = keyOf({ kind: 'step', workflow, step: null, name: to });
        dependencies.set(key, [...(dependencies.get(key) ?? []), from]);
        continue;
      }
      const content = fields.pop() ?? '';
      const [step, name] = kind === 'subagent' ? fields : [null, fields[0]];
      const item = { kind, workflow, step, name };
      items.set(keyOf(item), { item, content });
    }
  }
  return { items, dependencies };
}

/**
 * The pair the diff opens on when none is named: the newest two versions by first run, older as
 * `a`. Versions with a recorded architecture come first, so a version not parsed yet does not
 * hide a diff that can be shown; with fewer than two recorded it is the newest two. Null with
 * fewer than two versions.
 */
export function defaultPair(
  rows: readonly ArchDiffRow[],
): { a: string; b: string; recorded: boolean } | null {
  const firstRun = new Map<string, number>();
  for (const row of rows) {
    if (row.kind !== 'version') continue;
    const at = row.first_run_at?.getTime() ?? Number.NEGATIVE_INFINITY;
    firstRun.set(row.digest, Math.min(at, firstRun.get(row.digest) ?? Number.POSITIVE_INFINITY));
  }
  const byAge = [...firstRun].sort(([da, a], [db, b]) => a - b || da.localeCompare(db));
  const recorded = new Set(rows.filter((r) => r.kind !== 'version').map((r) => r.digest));
  const withArch = byAge.filter(([digest]) => recorded.has(digest));
  const [pool, isRecorded] = withArch.length >= 2 ? [withArch, true] : [byAge, false];
  if (pool.length < 2) return null;
  const [[a], [b]] = pool.slice(-2);
  return { a, b, recorded: isRecorded };
}

const keyOf = ({ kind, workflow, step, name }: Item): string =>
  JSON.stringify([kind, workflow, step, name]);

const order = (a: Item, b: Item): number =>
  (a.workflow ?? '').localeCompare(b.workflow ?? '') ||
  (a.step ?? '').localeCompare(b.step ?? '') ||
  a.name.localeCompare(b.name);

/**
 * What changed from version `a` to `b`. An item is added or removed by its key, and changed when
 * what it says differs. A step also changes when the steps it depends on do, except for steps
 * added or removed: dropping a step drops it from its dependants, and the diff already says the
 * step went.
 */
export function diffVersions(rows: readonly ArchDiffRow[], a: string, b: string): DiffResult {
  const named = [...new Set([a, b])];
  const notFound = named.filter(
    (digest) => !rows.some((r) => r.digest === digest && r.kind === 'version'),
  );
  if (notFound.length > 0) return { status: 'not-found', digests: notFound };
  const unrecorded = named.filter(
    (digest) => !rows.some((r) => r.digest === digest && r.kind !== 'version'),
  );
  if (unrecorded.length > 0) return { status: 'unrecorded', digests: unrecorded };

  const before = versionOf(rows, a);
  const after = versionOf(rows, b);
  const none = (): KindDiff => ({ added: [], removed: [], changed: [] });
  const diff: ArchDiff = { workflow: none(), step: none(), prompt: none(), subagent: none() };
  const comingOrGoing = new Set<string>();
  for (const [key, { item }] of after.items) {
    if (before.items.has(key)) continue;
    diff[item.kind].added.push(item);
    comingOrGoing.add(key);
  }
  for (const [key, { item }] of before.items) {
    if (after.items.has(key)) continue;
    diff[item.kind].removed.push(item);
    comingOrGoing.add(key);
  }
  const dependencies = (version: typeof before, { workflow }: Item, key: string) =>
    (version.dependencies.get(key) ?? [])
      .filter(
        (from) => !comingOrGoing.has(keyOf({ kind: 'step', workflow, step: null, name: from })),
      )
      .sort()
      .join('\n');
  for (const [key, { item, content }] of after.items) {
    const was = before.items.get(key);
    if (was === undefined) continue;
    if (
      was.content !== content ||
      (item.kind === 'step' && dependencies(before, item, key) !== dependencies(after, item, key))
    ) {
      diff[item.kind].changed.push(item);
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
export function itemLabel({ workflow, step, name }: Item): string {
  return [workflow, step, name].filter((part) => part !== null).join(' · ');
}
