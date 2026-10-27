import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findStep, joinParts, type NestingRow, type StepRow } from '../../app/lib/step-detail';
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
    // A long multi-byte file: each part must stay under the 16 KiB Realtime answers (REALTIME.md).
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
        `INSERT INTO mc.arch_hooks (archon_sha, factory_sha, path, text, admitted_agents)
         VALUES ($1, 'f', 'hooks/fence.py', $1, '{verifier}')`,
        [sha],
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
    await db.query(`INSERT INTO mc.arch_hooks (archon_sha, factory_sha, path, text, admitted_agents)
      VALUES ('a2', 'f', 'hooks/judge.py', 'manager hook', '{judge}')`);
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
    expect(await manager('step-scripts')).toEqual([
      { path: 'manager/scripts/check.ts', part: 0, chunk: 'manager script' },
    ]);
    expect(await manager('step-hooks')).toEqual([
      {
        path: 'hooks/judge.py',
        admitted_agents: ['judge'],
        workflow: 'archon-manager',
        step_path: 'check-app',
        agent: 'judge',
        description: 'manager judge',
      },
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
    expect(await db.query(sql('step-hooks'), paramsFor('step-hooks', 'mission-control'))).toEqual([
      {
        path: 'hooks/fence.py',
        admitted_agents: ['verifier'],
        workflow: 'archon-loop',
        step_path: 'check-app',
        agent: 'verifier',
        description: 'a2',
      },
    ]);

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
    const hooks = await db.query(sql('step-hooks'), ['mission-control', ...CHECK_APP, 'p1']);
    expect(hooks.map((h) => h.description)).toEqual(['a1']);

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

describe('step screens of included blocks on the seed', () => {
  let db: Db;
  const sql = (name: string) => queries.find(([n]) => n === name)?.[1] as string;
  const nestingOf = async (workflow: string, path: string) =>
    (await db.query(sql('step-nesting'), [
      'mission-control',
      workflow,
      path,
      '',
    ])) as unknown as NestingRow[];
  const opens = (row: NestingRow) => `${row.open_workflow} / ${row.open_path}`;

  beforeAll(async () => {
    db = await onTheSeed();
  }, 60_000);
  afterAll(() => db.close());

  test("the step that writes the code has its own screen and prompt, and no alias under deliver's block", async () => {
    const steps = (await db.query(sql('step-detail'), [
      'mission-control',
      '',
    ])) as unknown as StepRow[];
    expect(findStep(steps, 'archon-implement', 'implement')?.command_file).toBe(
      'implement/commands/implement.md',
    );
    expect(findStep(steps, 'archon-deliver-block', 'implement')).toBeUndefined();
    const parts = (await db.query(sql('step-prompt'), [
      'mission-control',
      'archon-implement',
      'implement',
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
    const V1 = '8e3e1cefaf1e1b7955789d6a43a81b6c2dbd7082';
    const V2 = '5ffd60c6c6e591487f2fbb5ec67ccc8fc55ca915';
    const stepsAt = async (version: string) =>
      (await db.query(sql('step-detail'), ['mission-control', version])) as unknown as StepRow[];
    expect(findStep(await stepsAt(''), 'archon-loop', 'briefs')).toBeUndefined();
    expect(findStep(await stepsAt(V1), 'archon-loop', 'briefs')).toBeDefined();
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

  test("deliver's screen lists both occurrences of implement, each opening its own screen", async () => {
    const inside = new Map(
      (await nestingOf('archon-ship-block', 'deliver'))
        .filter((row) => row.relation === 'inside')
        .map((row) => [row.path, opens(row)]),
    );
    expect(inside.get('deliver/rounds/implement')).toBe('archon-deliver-block / rounds/implement');
    expect(inside.get('deliver/rounds/implement/implement')).toBe('archon-implement / implement');
    expect(inside.get('deliver/rounds/reshape/implement')).toBe('archon-implement / implement');
  });

  test('every step beneath ship opens a screen that exists', async () => {
    const steps = (await db.query(sql('step-detail'), [
      'mission-control',
      '',
    ])) as unknown as StepRow[];
    const inside = (await nestingOf('archon-loop', 'ship')).filter((r) => r.relation === 'inside');
    expect(inside.length).toBeGreaterThan(50);
    const missing = inside.filter((row) => !findStep(steps, row.open_workflow, row.open_path));
    expect(missing.map((row) => row.path)).toEqual([]);
  });

  test("implement's screen lists every place an include puts it, opening the node it sits in", async () => {
    const places = (await nestingOf('archon-implement', 'implement'))
      .filter((row) => row.relation === 'included_at')
      .map((row) => `${row.workflow} ${row.path} -> ${opens(row)}`)
      .sort();
    expect(places).toEqual([
      'archon-deliver-block rounds/implement/implement -> archon-deliver-block / rounds/implement',
      'archon-deliver-block rounds/reshape/implement -> archon-deliver-block / rounds/reshape',
      'archon-loop ship/deliver/rounds/implement/implement -> archon-deliver-block / rounds/implement',
      'archon-loop ship/deliver/rounds/reshape/implement -> archon-deliver-block / rounds/reshape',
      'archon-ship-block deliver/rounds/implement/implement -> archon-deliver-block / rounds/implement',
      'archon-ship-block deliver/rounds/reshape/implement -> archon-deliver-block / rounds/reshape',
    ]);
  });
});
