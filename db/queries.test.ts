import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type ArchDiffRow,
  diffVersions,
  type Item,
  itemLabel,
  KINDS,
  type Kind,
} from '../app/lib/arch-diff';
import { seededDb } from '../scripts/fixture/seed';
import { writeRow } from '../scripts/fixture/write';
import { REPO_ROOT } from '../scripts/lib/cli';
import type { Db } from '../scripts/lib/db';
import { runMigrations } from '../scripts/migrate';
import { LIVE_QUERY_NAME, loadLiveQueries } from '../server/live';
import { archonDb, migrationFiles } from './test-db';

const dir = join(import.meta.dir, 'queries');
const queries = [...loadLiveQueries(dir)];

/** Functions whose value changes between evaluations; Realtime refuses them (REALTIME.md). */
const VOLATILE =
  /\b(now|random|clock_timestamp|statement_timestamp|transaction_timestamp|timeofday|gen_random_uuid|nextval|current_timestamp|current_date|current_time|localtime|localtimestamp)\b/i;

test('every file in db/queries/ is a live query named for its panel', () => {
  const sqlFiles = readdirSync(dir).filter((f) => f.endsWith('.sql'));
  expect(sqlFiles.length).toBeGreaterThan(0);
  for (const file of sqlFiles) expect(file.slice(0, -4)).toMatch(LIVE_QUERY_NAME);
});

describe.each(queries)('db/queries/%s.sql', (_name, sql) => {
  test('is one read-only SELECT', () => {
    expect(sql).not.toContain(';');
    expect(sql).toMatch(/^(SELECT|WITH)\b/i);
    expect(sql).not.toMatch(/\b(insert|update|delete|merge|truncate|for\s+update|for\s+share)\b/i);
  });

  test('uses no volatile function', () => {
    expect(sql).not.toMatch(VOLATILE);
  });

  test("reads the dashboard's own tables, never Archon's", () => {
    expect(sql).not.toMatch(/remote_agent_|provider_event/i);
  });

  test('is keyed by one factory, $1, and takes no other parameter', () => {
    expect(sql).toMatch(/\$1\b/);
    expect(sql).not.toMatch(/\$([2-9]|\d{2,})/);
  });
});

describe('against the migrated schema', () => {
  let db: Db;

  beforeAll(async () => {
    db = await archonDb();
    await runMigrations({ files: migrationFiles, db });
  });

  afterAll(() => db.close());

  test.each(queries)('%s runs with a factory name as $1', async (_name, sql) => {
    await db.query(sql, ['mission-control']);
  });

  test('status-strip counts one factory’s running laps and nothing else', async () => {
    await db.query(`INSERT INTO mc.laps (run_id, factory, workflow_name, status) VALUES
      ('00000000-0000-0000-0000-0000000000a1', 'mission-control', 'archon-loop', 'running'),
      ('00000000-0000-0000-0000-0000000000a2', 'mission-control', 'archon-loop', 'running'),
      ('00000000-0000-0000-0000-0000000000a3', 'mission-control', 'archon-loop', 'completed'),
      ('00000000-0000-0000-0000-0000000000a5', 'mission-control', 'archon-manager', 'running'),
      ('00000000-0000-0000-0000-0000000000a4', 'other', 'archon-loop', 'running')`);
    const sql = queries.find(([name]) => name === 'status-strip')?.[1] as string;
    expect(await db.query(sql, ['mission-control'])).toEqual([{ running: 2 }]);
    expect(await db.query(sql, ['other'])).toEqual([{ running: 1 }]);
  });
});

describe('version-strip on the seed', () => {
  let db: Db;
  const sql = queries.find(([name]) => name === 'version-strip')?.[1] as string;
  const strip = () => db.query(sql, ['mission-control']);

  beforeAll(async () => {
    db = await seededDb(REPO_ROOT, readFileSync(join(REPO_ROOT, 'fixtures', 'seed.sql'), 'utf8'));
  }, 60_000);

  afterAll(() => db.close());

  test('is one row per seeded version, labelled by the pin committed before its first run', async () => {
    const rows = (await strip()).sort(
      (a, b) =>
        Number(new Date(a.first_run_at as string)) - Number(new Date(b.first_run_at as string)),
    );
    const versions = await db.query(
      'SELECT digest, pin_sha FROM mc.versions WHERE factory = $1 ORDER BY first_run_at',
      ['mission-control'],
    );
    const pins = await db.query('SELECT sha FROM mc.pins ORDER BY committed_at');
    expect(rows.map(({ digest, pin_sha }) => ({ digest, pin_sha }))).toEqual(
      versions.map(({ digest, pin_sha }) => ({ digest, pin_sha })),
    );
    expect(rows.map((r) => r.pin_sha)).toEqual(pins.map((p) => p.sha));
    expect(rows[2]).toMatchObject({ hypothesis: null, measure: null });
  });

  test('each pin written after the last run adds one entry that has not run yet', async () => {
    await db.transaction(async (tx) => {
      await writeRow(tx, 'pin', new Date('2026-10-25T12:00:00Z'));
    });
    const [pin] = await db.query('SELECT sha FROM mc.pins ORDER BY committed_at DESC LIMIT 1');
    const rows = await strip();
    expect(rows).toHaveLength(4);
    expect(rows.filter((r) => r.digest === null).map((r) => r.pin_sha)).toEqual([pin.sha]);

    await db.transaction(async (tx) => {
      await writeRow(tx, 'pin', new Date('2026-10-25T12:03:00Z'));
    });
    expect(await strip()).toHaveLength(5);
  });
});

describe('arch-diff on the seed', () => {
  let db: Db;
  const sql = queries.find(([name]) => name === 'arch-diff')?.[1] as string;
  let rows: ArchDiffRow[];
  let digests: string[];

  beforeAll(async () => {
    db = await seededDb(REPO_ROOT, readFileSync(join(REPO_ROOT, 'fixtures', 'seed.sql'), 'utf8'));
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
      const [version] = await db.query(
        `SELECT a.archon_sha, a.factory_sha FROM mc.versions v
         JOIN mc.pins p ON p.sha = v.pin_sha
         JOIN mc.arch_versions a ON a.archon_sha = p.archon_sha
         WHERE v.digest = $1 ORDER BY a.parsed_at DESC LIMIT 1`,
        [v2],
      );
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
