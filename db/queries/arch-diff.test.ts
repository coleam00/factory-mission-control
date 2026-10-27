import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  type ArchDiffRow,
  diffVersions,
  type Item,
  itemLabel,
  KINDS,
  type Kind,
} from '../../app/lib/arch-diff';
import type { Db } from '../../scripts/lib/db';
import { onTheSeed, queries } from './test-seed';

/** The architecture a version ran: the latest pin committed before its first lap, as parsed. */
async function archOf(db: Db, digest: string): Promise<Record<string, unknown>> {
  const [version] = await db.query(
    `SELECT a.archon_sha, a.factory_sha FROM mc.arch_versions a
     WHERE a.archon_sha = (
       SELECT p.archon_sha FROM mc.pins p
       WHERE p.committed_at < (SELECT min(started_at) FROM mc.laps WHERE digest = $1)
       ORDER BY p.committed_at DESC LIMIT 1)
     ORDER BY a.parsed_at DESC LIMIT 1`,
    [digest],
  );
  return version;
}

describe('arch-diff on the seed', () => {
  let db: Db;
  const sql = queries.find(([name]) => name === 'arch-diff')?.[1] as string;
  let rows: ArchDiffRow[];
  let digests: string[];

  beforeAll(async () => {
    db = await onTheSeed();
    rows = (await db.query(sql, ['mission-control'])) as unknown as ArchDiffRow[];
    const versions = await db.query(
      'SELECT digest FROM mc.versions WHERE factory = $1 ORDER BY first_run_at',
      ['mission-control'],
    );
    digests = versions.map((v) => String(v.digest));
  }, 60_000);

  afterAll(() => db.close());

  test('V1 to V2 is exactly the scripted change: a step added and removed, a prompt and a subagent changed', () => {
    const [v1, v2] = digests;
    const result = diffVersions(rows, v1, v2);
    if (result.status !== 'compared')
      throw new Error(`expected a comparison, got ${result.status}`);
    const listed = KINDS.flatMap((kind) =>
      (['added', 'removed', 'changed'] as const).flatMap((change) =>
        result.diff[kind][change].map((item) => `${change} ${kind} ${itemLabel(item)}`),
      ),
    );
    expect(listed).toEqual([
      'added step archon-loop · tally',
      'removed step archon-loop · briefs',
      'changed prompt loop/commands/loop-review.md',
      'changed subagent archon-manager · manage · holdout-writer',
    ]);
  });

  test('a version against itself has no change, and a version never parsed is unrecorded', () => {
    const [v1, , v3] = digests;
    expect(diffVersions(rows, v1, v1)).toMatchObject({ status: 'compared', changes: 0 });
    expect(diffVersions(rows, v1, v3)).toEqual({ status: 'unrecorded', digests: [v3] });
  });

  test('a version whose pin has no Archon sha yet stays on the strip and is unrecorded, never another', async () => {
    const [v1, v2] = digests;
    const [pin] = await db.query(
      'SELECT p.sha, p.archon_sha FROM mc.versions v JOIN mc.pins p ON p.sha = v.pin_sha WHERE v.digest = $1',
      [v2],
    );
    const strip = queries.find(([name]) => name === 'version-strip')?.[1] as string;
    await db.query('UPDATE mc.pins SET archon_sha = NULL WHERE sha = $1', [pin?.sha]);
    try {
      const unresolved = (await db.query(sql, ['mission-control'])) as unknown as ArchDiffRow[];
      expect(diffVersions(unresolved, v1, v2)).toEqual({ status: 'unrecorded', digests: [v2] });
      const listed = await db.query(strip, ['mission-control']);
      expect(listed.find((r) => r.digest === v2)).toMatchObject({ pin_sha: pin?.sha });
    } finally {
      await db.query('UPDATE mc.pins SET archon_sha = $2 WHERE sha = $1', [
        pin?.sha,
        pin?.archon_sha,
      ]);
    }
  });

  test("names no other factory's versions", async () => {
    expect(await db.query(sql, ['other'])).toEqual([]);
  });

  /**
   * Each architecture table, the columns that name its item, and the columns deliberately not
   * part of what it says. Every other column must count as a change, so a column the query stops
   * hashing, or one a migration adds, fails here.
   */
  const tables: {
    table: string;
    kind: Kind;
    item: (row: Record<string, unknown>) => Item;
    key: string[];
    ignored: string[];
  }[] = [
    {
      table: 'arch_workflows',
      kind: 'workflow',
      item: (r) => ({ kind: 'workflow', workflow: null, step: null, name: String(r.name) }),
      key: ['name'],
      // The YAML text changes whenever any step does, so it would list every edited workflow.
      ignored: ['yaml'],
    },
    {
      table: 'arch_steps',
      kind: 'step',
      item: (r) => ({
        kind: 'step',
        workflow: String(r.workflow),
        step: null,
        name: String(r.path),
      }),
      key: ['workflow', 'path'],
      // Removing a step renumbers the rest; wiring is compared from mc.arch_edges.
      ignored: ['parent_path', 'position', 'step_id', 'depends_on'],
    },
    {
      table: 'arch_texts',
      kind: 'prompt',
      item: (r) => ({ kind: 'prompt', workflow: null, step: null, name: String(r.path) }),
      key: ['path'],
      ignored: [],
    },
    {
      table: 'arch_subagents',
      kind: 'subagent',
      item: (r) => ({
        kind: 'subagent',
        workflow: String(r.workflow),
        step: String(r.step_path),
        name: String(r.name),
      }),
      key: ['workflow', 'step_path', 'name'],
      ignored: [],
    },
  ];

  test.each(tables)(
    'an edit to any column of $table that says something is listed as a changed $kind',
    async ({ table, kind, item, key, ignored }) => {
      const [v1, v2] = digests;
      const baseline = diffVersions(rows, v1, v2);
      if (baseline.status !== 'compared') throw new Error('expected a comparison');
      const scripted = [...baseline.diff[kind].added, ...baseline.diff[kind].changed];
      const version = await archOf(db, v2);
      const candidates = await db.query(
        `SELECT * FROM mc.${table} WHERE archon_sha = $1 AND factory_sha = $2`,
        [version.archon_sha, version.factory_sha],
      );
      const row = candidates.find(
        (r) => !scripted.some((s) => itemLabel(s) === itemLabel(item(r))),
      );
      if (!row) throw new Error(`no ${table} row in V2 that the seed leaves unchanged`);
      const columns = (
        await db.query(
          `SELECT column_name FROM information_schema.columns
           WHERE table_schema = 'mc' AND table_name = $1 ORDER BY ordinal_position`,
          [table],
        )
      )
        .map((c) => String(c.column_name))
        .filter((c) => !['archon_sha', 'factory_sha', ...key, ...ignored].includes(c));
      expect(columns.length).toBeGreaterThan(0);

      const unlisted: string[] = [];
      for (const column of columns) {
        const rollback = new Error('rollback');
        await db
          .transaction(async (tx) => {
            await tx.query(
              `UPDATE mc.${table} SET ${column} = coalesce(${column}, '') || '~'
               WHERE archon_sha = $1 AND factory_sha = $2
                 AND ${key.map((c, i) => `${c} = $${i + 3}`).join(' AND ')}`,
              [version.archon_sha, version.factory_sha, ...key.map((c) => row[c])],
            );
            const edited = (await tx.query(sql, ['mission-control'])) as unknown as ArchDiffRow[];
            const result = diffVersions(edited, v1, v2);
            if (result.status !== 'compared') throw new Error('expected a comparison');
            if (!result.diff[kind].changed.some((c) => itemLabel(c) === itemLabel(item(row)))) {
              unlisted.push(column);
            }
            throw rollback;
          })
          .catch((error) => {
            if (error !== rollback) throw error;
          });
      }
      expect(unlisted).toEqual([]);
    },
  );
});

describe('arch-diff on versions known only from their laps', () => {
  let db: Db;
  const sql = queries.find(([name]) => name === 'arch-diff')?.[1] as string;

  beforeAll(async () => {
    db = await onTheSeed();
    // As runs projected before 0008 are until `reconcile:laps` writes their versions.
    await db.query('DELETE FROM mc.versions');
  }, 60_000);

  afterAll(() => db.close());

  test('V1 to V2 is still exactly the scripted change, and V3 is still unrecorded', async () => {
    const rows = (await db.query(sql, ['mission-control'])) as unknown as ArchDiffRow[];
    const [v1, v2, v3] = (
      await db.query(
        `SELECT digest FROM mc.laps WHERE factory = $1 AND digest IS NOT NULL
         GROUP BY digest ORDER BY min(started_at)`,
        ['mission-control'],
      )
    ).map((v) => String(v.digest));
    const result = diffVersions(rows, v1, v2);
    if (result.status !== 'compared')
      throw new Error(`expected a comparison, got ${result.status}`);
    expect(
      KINDS.flatMap((kind) =>
        (['added', 'removed', 'changed'] as const).flatMap((change) =>
          result.diff[kind][change].map((item) => `${change} ${kind} ${itemLabel(item)}`),
        ),
      ),
    ).toEqual([
      'added step archon-loop · tally',
      'removed step archon-loop · briefs',
      'changed prompt loop/commands/loop-review.md',
      'changed subagent archon-manager · manage · holdout-writer',
    ]);
    expect(diffVersions(rows, v1, v3)).toEqual({ status: 'unrecorded', digests: [v3] });
  });
});
