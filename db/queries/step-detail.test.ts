import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  isIncluded,
  joinParts,
  type NestingRow,
  placeOf,
  placesOf,
  type StepRow,
} from '../../app/lib/step-detail';
import { REPO_ROOT } from '../../scripts/lib/cli';
import type { Db } from '../../scripts/lib/db';
import { CHECK_APP, migratedDb, onTheSeed, paramsFor, queries, STEP_PANELS } from './test-seed';

describe('against the migrated schema', () => {
  let db: Db;

  beforeAll(async () => {
    db = await migratedDb();
  });

  afterAll(() => db.close());

  test('step queries read the newest pin with architecture rows, or the pin the address names, for a factory the dashboard shows', async () => {
    const sql = (name: string) => queries.find(([n]) => n === name)?.[1] as string;
    // A long multi-byte file: each part must stay under the 16 KiB the live probe tests (REALTIME.md).
    const long = `${'é'.repeat(4500)}
${'x'.repeat(5000)}`;
    await db.query(`INSERT INTO mc.factories (name, repository, codebase, console)
      VALUES ('mission-control', 'o/r', 'o/r', 'http://localhost:3090')`);
    await db.query(`INSERT INTO mc.pins (sha, archon_sha, reason, committed_at) VALUES
      ('p1', 'a1', 'one', '2026-01-01T00:00:00Z'),
      ('p2', 'a2', 'two', '2026-02-01T00:00:00Z'),
      ('p3', 'a3', 'three, not parsed yet', '2026-03-01T00:00:00Z')`);
    await db.query(`INSERT INTO mc.arch_versions (archon_sha, factory_sha, parsed_at) VALUES
      ('a1', 'f', '2026-01-02T00:00:00Z'), ('a2', 'f', '2026-02-02T00:00:00Z')`);
    // Both versions share every name and path, so a query that leaks a1 doubles or mixes rows.
    for (const [sha, deps] of [
      ['a1', '{subject,briefs}'],
      ['a2', '{subject}'],
    ]) {
      await db.query(
        `INSERT INTO mc.arch_steps (archon_sha, factory_sha, workflow, path, position, step_id, kind,
           depends_on, command_file, script_file, defined_in, file)
         VALUES ($1, 'f', 'archon-loop', 'check-app', 0, 'check-app', 'command', $2,
           'loop/commands/loop-check-app.md', 'loop/scripts/check.ts', 'archon-loop',
           'loop/archon-loop.yaml')`,
        [sha, deps],
      );
      await db.query(
        `INSERT INTO mc.arch_texts (archon_sha, factory_sha, path, text) VALUES
           ($1, 'f', 'loop/commands/loop-check-app.md', $2),
           ($1, 'f', 'loop/agents/verifier.md', $2)`,
        [sha, `${sha} ${long}`],
      );
      await db.query(
        `INSERT INTO mc.arch_subagents (archon_sha, factory_sha, workflow, step_path, name,
           description, instruction_file)
         VALUES ($1, 'f', 'archon-loop', 'check-app', 'verifier', $1, 'loop/agents/verifier.md')`,
        [sha],
      );
      await db.query(
        `INSERT INTO mc.arch_scripts (archon_sha, factory_sha, path, text)
         VALUES ($1, 'f', 'loop/scripts/check.ts', $2)`,
        [sha, `${sha} ${long}`],
      );
      await db.query(
        `INSERT INTO mc.arch_workflows (archon_sha, factory_sha, name, file, yaml)
         VALUES ($1, 'f', 'archon-loop', 'loop/archon-loop.yaml', $2)`,
        [sha, `${sha} ${long}`],
      );
    }

    for (const [name, query] of queries.filter(([n]) => n.startsWith('step-'))) {
      expect([name, await db.query(query, paramsFor(name, 'other'))]).toEqual([name, []]);
    }
    for (const name of STEP_PANELS) {
      const otherStep = await db.query(sql(name), [
        'mission-control',
        'archon-loop',
        'subject',
        '',
      ]);
      expect([name, otherStep]).toEqual([name, []]);
    }
    const steps = await db.query(sql('step-detail'), ['mission-control', '']);
    expect(steps.map((s) => s.depends_on)).toEqual([['subject']]);

    // A second workflow with a step at the same path and files of its own: a step panel that
    // ignores the workflow ($2) shows them on archon-loop's step too.
    await db.query(
      `INSERT INTO mc.arch_steps (archon_sha, factory_sha, workflow, path, position, step_id, kind,
         depends_on, command_file, script_file, defined_in, file)
       VALUES ('a2', 'f', 'archon-manager', 'check-app', 0, 'check-app', 'command', '{}',
         'manager/commands/check.md', 'manager/scripts/check.ts', 'archon-manager',
         'manager/archon-manager.yaml')`,
    );
    await db.query(`INSERT INTO mc.arch_texts (archon_sha, factory_sha, path, text) VALUES
      ('a2', 'f', 'manager/commands/check.md', 'manager prompt'),
      ('a2', 'f', 'manager/agents/judge.md', 'manager judge file')`);
    await db.query(`INSERT INTO mc.arch_subagents (archon_sha, factory_sha, workflow, step_path,
        name, description, instruction_file)
      VALUES ('a2', 'f', 'archon-manager', 'check-app', 'judge', 'manager judge',
        'manager/agents/judge.md')`);
    await db.query(`INSERT INTO mc.arch_scripts (archon_sha, factory_sha, path, text)
      VALUES ('a2', 'f', 'manager/scripts/check.ts', 'manager script')`);
    await db.query(`INSERT INTO mc.arch_workflows (archon_sha, factory_sha, name, file, yaml)
      VALUES ('a2', 'f', 'archon-manager', 'manager/archon-manager.yaml', 'manager yaml')`);
    const manager = (name: string) =>
      db.query(sql(name), ['mission-control', 'archon-manager', 'check-app', '']);
    expect(await manager('step-prompt')).toEqual([
      { path: 'manager/commands/check.md', part: 0, chunk: 'manager prompt' },
    ]);
    expect(await manager('step-subagents')).toEqual([
      {
        workflow: 'archon-manager',
        step_path: 'check-app',
        name: 'judge',
        description: 'manager judge',
        prompt: null,
        instruction_file: 'manager/agents/judge.md',
        part: 0,
        chunk: 'manager judge file',
      },
    ]);
    await db.query(`INSERT INTO mc.arch_subagents (archon_sha, factory_sha, workflow, step_path,
        name, description) VALUES ('a2', 'f', 'archon-manager', 'check-app', 'holdout-writer', 'x')`);
    expect((await manager('step-subagents')).map((r) => r.name)).toEqual(['judge']);
    expect(await manager('step-scripts')).toEqual([
      { path: 'manager/scripts/check.ts', part: 0, chunk: 'manager script' },
    ]);
    expect(await manager('step-yaml')).toEqual([
      {
        name: 'archon-manager',
        file: 'manager/archon-manager.yaml',
        part: 0,
        chunk: 'manager yaml',
      },
    ]);

    const files = async (
      name: string,
      key: (row: Record<string, unknown>) => unknown,
      version = '',
    ) => {
      const parts = (await db.query(sql(name), ['mission-control', ...CHECK_APP, version])) as {
        part: number;
        chunk: string;
      }[];
      expect(parts.length).toBe(3);
      for (const { chunk } of parts) expect(Buffer.byteLength(chunk)).toBeLessThan(16 * 1024);
      return joinParts(parts, (row) => String(key(row)));
    };
    expect(await files('step-prompt', (row) => row.path)).toEqual(
      new Map([['loop/commands/loop-check-app.md', `a2 ${long}`]]),
    );
    expect(await files('step-subagents', (row) => `${row.name} ${row.description}`)).toEqual(
      new Map([['verifier a2', `a2 ${long}`]]),
    );
    expect(await files('step-scripts', (row) => row.path)).toEqual(
      new Map([['loop/scripts/check.ts', `a2 ${long}`]]),
    );
    expect(await files('step-yaml', (row) => row.name)).toEqual(
      new Map([['archon-loop', `a2 ${long}`]]),
    );

    // The version the address names by its pin, and nothing for any other value.
    const olderSteps = await db.query(sql('step-detail'), ['mission-control', 'p1']);
    expect(olderSteps.map((s) => s.depends_on)).toEqual([['subject', 'briefs']]);
    expect(await files('step-prompt', (row) => row.path, 'p1')).toEqual(
      new Map([['loop/commands/loop-check-app.md', `a1 ${long}`]]),
    );
    expect(await files('step-subagents', (row) => `${row.name} ${row.description}`, 'p1')).toEqual(
      new Map([['verifier a1', `a1 ${long}`]]),
    );
    expect(await files('step-scripts', (row) => row.path, 'p1')).toEqual(
      new Map([['loop/scripts/check.ts', `a1 ${long}`]]),
    );
    expect(await files('step-yaml', (row) => row.name, 'p1')).toEqual(
      new Map([['archon-loop', `a1 ${long}`]]),
    );

    // A pin with no architecture, an archon sha, a prefix of a pin, a made-up value, and a known
    // pin for a factory the dashboard does not show.
    for (const [factory, version] of [
      ['mission-control', 'p3'],
      ['mission-control', 'a1'],
      ['mission-control', 'p'],
      ['mission-control', 'nope'],
      ['other', 'p1'],
    ]) {
      expect(await db.query(sql('step-detail'), [factory, version])).toEqual([]);
      for (const name of STEP_PANELS) {
        const rows = await db.query(sql(name), [factory, ...CHECK_APP, version]);
        expect([name, version, rows]).toEqual([name, version, []]);
      }
    }

    // The versions the screen can open: the pins with architecture, the one shown without a
    // version marked.
    const versions = await db.query(sql('step-versions'), ['mission-control']);
    expect(
      versions
        .map((v) => [v.sha, v.is_current])
        .sort(([a], [b]) => String(a).localeCompare(String(b))),
    ).toEqual([
      ['p1', false],
      ['p2', true],
    ]);
    expect(await db.query(sql('step-versions'), ['other'])).toEqual([]);
  });
});

describe('the version the picker marks current', () => {
  let db: Db;
  const sql = (name: string) => queries.find(([n]) => n === name)?.[1] as string;

  beforeAll(async () => {
    db = await migratedDb();
  });

  afterAll(() => db.close());

  test('is the one the step queries show without a version, when two pins tie on their commit', async () => {
    await db.query(`INSERT INTO mc.factories (name, repository, codebase, console)
      VALUES ('mission-control', 'o/r', 'o/r', 'http://localhost:3090')`);
    await db.query(`INSERT INTO mc.pins (sha, archon_sha, reason, committed_at) VALUES
      ('p1', 'a1', 'one', '2026-01-01T00:00:00Z'), ('p2', 'a2', 'two', '2026-01-01T00:00:00Z')`);
    for (const sha of ['a1', 'a2']) {
      await db.query(
        `INSERT INTO mc.arch_steps (archon_sha, factory_sha, workflow, path, position, step_id, kind,
           description, depends_on, defined_in, file)
         VALUES ($1, 'f', 'archon-loop', 'review', 0, 'review', 'prompt', $1, '{}', 'archon-loop',
           'loop/archon-loop.yaml')`,
        [sha],
      );
    }
    // Each order of parsing in turn: the one parsed last is current.
    for (const [first, last, current] of [
      ['a1', 'a2', 'p2'],
      ['a2', 'a1', 'p1'],
    ]) {
      await db.query('DELETE FROM mc.arch_versions');
      await db.query(
        `INSERT INTO mc.arch_versions (archon_sha, factory_sha, parsed_at)
         VALUES ($1, 'f', '2026-01-02T00:00:00Z'), ($2, 'f', '2026-01-03T00:00:00Z')`,
        [first, last],
      );
      const marked = (await db.query(sql('step-versions'), ['mission-control']))
        .filter((v) => v.is_current)
        .map((v) => v.sha);
      expect(marked).toEqual([current]);
      const shown = async (version: string) =>
        (await db.query(sql('step-detail'), ['mission-control', version])).map(
          (s) => s.description,
        );
      expect(await shown('')).toEqual(await shown(current));
      expect(await shown('')).toEqual([last]);
    }
  });
});

describe('step places of included blocks on the seed', () => {
  let db: Db;
  const sql = (name: string) => queries.find(([n]) => n === name)?.[1] as string;
  const nestingOf = async (workflow: string, path: string) =>
    (await db.query(sql('step-nesting'), [
      'mission-control',
      workflow,
      path,
      '',
    ])) as unknown as NestingRow[];
  const V1 = '8e3e1cefaf1e1b7955789d6a43a81b6c2dbd7082';
  const stepsAt = async (version: string) =>
    (await db.query(sql('step-detail'), ['mission-control', version])) as unknown as StepRow[];

  beforeAll(async () => {
    db = await onTheSeed();
  }, 60_000);
  afterAll(() => db.close());

  test('no agent the fence admits is listed on any step screen, at any pin', async () => {
    const fenced = await db.query(
      `SELECT DISTINCT a.workflow, a.step_path, a.name, pn.sha AS pin
       FROM mc.arch_hooks h
       CROSS JOIN LATERAL unnest(h.admitted_agents) AS f(agent)
       JOIN mc.arch_subagents a ON a.archon_sha = h.archon_sha AND a.factory_sha = h.factory_sha
         AND a.name = f.agent
       JOIN mc.pins pn ON pn.archon_sha = a.archon_sha
       WHERE h.path ILIKE '%fence%'`,
    );
    expect(fenced.length).toBeGreaterThan(0);
    for (const f of fenced) {
      const listed = await db.query(sql('step-subagents'), [
        'mission-control',
        f.workflow,
        f.step_path,
        f.pin,
      ]);
      expect([f.name, listed.some((r) => r.name === f.name)]).toEqual([f.name, false]);
    }
  });

  test('the step that writes the code is declared in implement, and its address opens its first place', async () => {
    const steps = await stepsAt('');
    expect(placeOf(steps, 'archon-implement', 'implement')?.step.command_file).toBe(
      'implement/commands/implement.md',
    );
    expect(placeOf(steps, 'archon-deliver-block', 'implement')).toBeUndefined();
    expect(isIncluded(steps, 'archon-implement')).toBe(true);
    expect(placesOf(steps, 'archon-implement', 'implement')[0]).toEqual({
      workflow: 'archon-loop',
      path: 'ship/deliver/rounds/implement/implement',
    });
  });

  test("a place's prompt is its definition's file, byte for byte", async () => {
    const parts = (await db.query(sql('step-prompt'), [
      'mission-control',
      'archon-loop',
      'ship/deliver/rounds/implement/implement',
      '',
    ])) as { path: string; part: number; chunk: string }[];
    expect(joinParts(parts, (row) => row.path).get('implement/commands/implement.md')).toBe(
      readFileSync(
        join(REPO_ROOT, 'fixtures', 'pack', 'sdlc', 'implement', 'commands', 'implement.md'),
        'utf8',
      ),
    );
  });

  test('an older pin opens the step as it was: V1 has briefs and its own review prompt', async () => {
    const V2 = '5ffd60c6c6e591487f2fbb5ec67ccc8fc55ca915';
    expect(placeOf(await stepsAt(''), 'archon-loop', 'briefs')).toBeUndefined();
    expect(placeOf(await stepsAt(V1), 'archon-loop', 'briefs')).toBeDefined();
    const reviewPrompt = async (version: string) =>
      joinParts(
        (await db.query(sql('step-prompt'), [
          'mission-control',
          'archon-loop',
          'review',
          version,
        ])) as { path: string; part: number; chunk: string }[],
        (row) => row.path,
      ).get('loop/commands/loop-review.md');
    const current = await reviewPrompt('');
    expect(current).toBeString();
    expect(await reviewPrompt(V2)).toBe(current);
    expect(await reviewPrompt(V1)).toBeString();
    expect(await reviewPrompt(V1)).not.toBe(current);
  });

  test('every declared step of an included workflow has places that open back to it, at every version', async () => {
    for (const version of ['', V1]) {
      const steps = await stepsAt(version);
      const included = steps.filter((row) => isIncluded(steps, row.workflow));
      expect(included.length).toBeGreaterThan(50);
      for (const row of included) {
        const places = placesOf(steps, row.workflow, row.path);
        expect(places.length).toBeGreaterThan(0);
        for (const place of places) {
          expect(isIncluded(steps, place.workflow)).toBe(false);
          expect(placeOf(steps, place.workflow, place.path)?.step).toBe(row);
        }
      }
    }
  });

  test('every stored row of a top-level workflow is found from the declared rows alone', async () => {
    for (const version of ['', V1]) {
      const steps = await stepsAt(version);
      const stored = (await db.query(
        `WITH version AS (
           SELECT a.archon_sha, a.factory_sha FROM mc.arch_versions a
           JOIN mc.pins p ON p.archon_sha = a.archon_sha
           WHERE $1 = '' OR p.sha = $1
           ORDER BY p.committed_at DESC, a.parsed_at DESC LIMIT 1
         )
         SELECT s.workflow, s.path, s.defined_in, s.step_id, s.kind, s.model, s.when_condition,
           s.depends_on, s.trigger_rule, s.include
         FROM mc.arch_steps s JOIN version v
           ON v.archon_sha = s.archon_sha AND v.factory_sha = s.factory_sha`,
        [version],
      )) as unknown as StepRow[];
      const topLevel = stored.filter((row) => !isIncluded(steps, row.workflow));
      expect(topLevel.length).toBeGreaterThan(100);
      const wrong = topLevel.filter((row) => {
        const found = placeOf(steps, row.workflow, row.path)?.step;
        return (
          found === undefined ||
          found.workflow !== row.defined_in ||
          found.step_id !== row.step_id ||
          found.kind !== row.kind ||
          found.model !== row.model ||
          found.when_condition !== row.when_condition ||
          found.trigger_rule !== row.trigger_rule ||
          found.include !== row.include ||
          found.depends_on.join() !== row.depends_on.join()
        );
      });
      expect(wrong.map((row) => `${row.workflow} ${row.path}`)).toEqual([]);
    }
  });

  test('the review block runs at two places that differ in their routing', async () => {
    const steps = await stepsAt('');
    const places = placesOf(steps, 'archon-review-block', 'code');
    expect(places).toEqual([
      { workflow: 'archon-loop', path: 'ship/deliver/rounds/review/code' },
      { workflow: 'archon-loop', path: 'ship/deliver/rounds/rereview/code' },
    ]);
    const inputs = places.map((place) => {
      const around = placeOf(steps, place.workflow, place.path)?.around ?? [];
      return around.at(-1)?.row.depends_on;
    });
    expect(inputs).toEqual([['pr'], ['reshape']]);
  });

  test("deliver's place lists both occurrences of implement, each opening its own place", async () => {
    const inside = (await nestingOf('archon-loop', 'ship/deliver')).map((row) => row.path);
    expect(inside).toContain('ship/deliver/rounds/implement/implement');
    expect(inside).toContain('ship/deliver/rounds/reshape/implement');
  });

  test('every step beneath ship opens a place that exists', async () => {
    const steps = await stepsAt('');
    const inside = await nestingOf('archon-loop', 'ship');
    expect(inside.length).toBeGreaterThan(50);
    const missing = inside.filter((row) => !placeOf(steps, 'archon-loop', row.path));
    expect(missing.map((row) => row.path)).toEqual([]);
  });
});
