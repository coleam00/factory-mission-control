import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadRefusal, parsePack, type Step, type Workflow } from './pack';

const repoRoot = resolve(import.meta.dir, '..');
const packDir = join(repoRoot, 'fixtures', 'pack', 'sdlc');
const templateDir = join(repoRoot, 'fixtures', 'factory-template');
const parsed = parsePack(packDir, templateDir);

function workflow(name: string): Workflow {
  const found = parsed.workflows.find((w) => w.name === name);
  if (!found) throw new Error(`no workflow ${name}`);
  return found;
}

function step(steps: Step[], id: string): Step {
  const found = steps.find((s) => s.id === id);
  if (!found) throw new Error(`no step ${id}`);
  return found;
}

const loop = workflow('archon-loop');

describe('archon-loop', () => {
  test('lists its steps in order', () => {
    expect(loop.steps.map((s) => s.id)).toEqual([
      'pick',
      'claim',
      'build',
      'ship',
      'subject',
      'briefs',
      'check-app',
      'evidence',
      'review',
      'land',
      'deploy',
      'release',
    ]);
  });

  test('expands ship from archon-ship-block, with each stage’s own includes expanded', () => {
    const ship = step(loop.steps, 'ship');
    expect(ship.kind).toBe('include');
    expect(ship.include).toBe('archon-ship-block');
    expect(ship.steps.map((s) => s.id)).toEqual([
      'forge',
      'triage',
      'inv',
      'intel',
      'planned',
      'continues',
      'deliver',
      'outcome',
      'report',
    ]);
    for (const stage of ship.steps) {
      expect(stage.path).toBe(`ship/${stage.id}`);
      expect(stage.definedIn).toBe('archon-ship-block');
      if (stage.include) {
        const included = workflow(stage.include);
        expect(stage.steps.map((s) => s.id)).toEqual(included.steps.map((s) => s.id));
      }
    }
    expect(step(ship.steps, 'triage').include).toBe('archon-triage-block');
    expect(step(ship.steps, 'inv').include).toBe('archon-investigate');
    expect(step(ship.steps, 'planned').include).toBe('archon-plan-block');
    expect(step(ship.steps, 'deliver').include).toBe('archon-deliver-block');

    // Includes inside a loop group are expanded too, all the way down.
    const rounds = step(step(ship.steps, 'deliver').steps, 'rounds');
    expect(rounds.kind).toBe('loop_group');
    const review = step(rounds.steps, 'review');
    expect(review.path).toBe('ship/deliver/rounds/review');
    expect(review.include).toBe('archon-review-block');
    expect(review.steps.map((s) => s.id)).toEqual(
      workflow('archon-review-block').steps.map((s) => s.id),
    );
  });

  test('check-app carries its command text, holdout-verifier subagent and dependencies', () => {
    const checkApp = step(loop.steps, 'check-app');
    expect(checkApp.kind).toBe('command');
    expect(checkApp.commandFile).toBe('loop/commands/loop-check-app.md');
    expect(checkApp.commandText).toBe(
      readFileSync(join(packDir, 'loop', 'commands', 'loop-check-app.md'), 'utf8'),
    );
    expect(checkApp.dependsOn).toEqual(['subject', 'briefs']);
    expect(checkApp.agents.map((a) => a.name)).toEqual(['holdout-verifier']);
    const [verifier] = checkApp.agents;
    expect(verifier?.description).toBe(
      "Runs the project's holdout scenarios against a checkout and returns a verdict and what a user sees per scenario id, never the scenarios. The only agent allowed to read them.",
    );
    expect(verifier?.instructionFile).toBe('holdouts/commands/holdout-verifier.md');
    expect(verifier?.instructionText).toBe(
      readFileSync(join(packDir, 'holdouts', 'commands', 'holdout-verifier.md'), 'utf8'),
    );
  });

  test('land carries its when exactly as written', () => {
    expect(step(loop.steps, 'land').when).toBe(
      "$review.output.outcome == 'merge' && $INPUTS.merge == 'auto'",
    );
  });

  test('steps carry kind, model tier, trigger rule, scripts and their YAML comment', () => {
    const claim = step(loop.steps, 'claim');
    expect(claim.kind).toBe('script');
    expect(claim.scriptFile).toBe('loop/scripts/claim.ts');
    expect(claim.runtime).toBe('bun');
    expect(claim.description).toStartWith('Several runs of this loop may work one repository');
    expect(claim.model).toBeNull();
    expect(step(loop.steps, 'pick').model).toBe('large');
    expect(step(step(loop.steps, 'ship').steps, 'intel').model).toBe('medium');
    expect(step(loop.steps, 'release').triggerRule).toBe('all_done');
    expect(loop.yaml).toBe(readFileSync(join(packDir, 'loop', 'archon-loop.yaml'), 'utf8'));
  });

  test('edges follow depends_on through the expanded tree', () => {
    expect(loop.edges).toContainEqual({ from: 'subject', to: 'check-app' });
    expect(loop.edges).toContainEqual({ from: 'briefs', to: 'check-app' });
    expect(loop.edges).toContainEqual({ from: 'ship/forge', to: 'ship/triage' });
    expect(loop.edges).toContainEqual({
      from: 'ship/deliver/rounds/implement',
      to: 'ship/deliver/rounds/pr',
    });
  });
});

describe('the pack', () => {
  test('includes the manager, holdouts and backlog workflows', () => {
    const names = parsed.workflows.map((w) => w.name);
    expect(names).toContain('archon-manager');
    expect(names).toContain('archon-holdouts');
    expect(names).toContain('archon-backlog');
  });

  test('reads command and script texts from the pack', () => {
    expect(parsed.commands.map((c) => c.path)).toContain('loop/commands/loop-pick.md');
    expect(parsed.scripts.map((s) => s.path)).toContain('loop/scripts/land.ts');
    expect(parsed.scripts.map((s) => s.path)).toContain('.shared/merge-gate.ts');
    expect(parsed.archonCommit).toBe(
      readFileSync(join(repoRoot, 'fixtures', 'pack', 'ARCHON_COMMIT'), 'utf8').trim(),
    );
    expect(parsed.factoryCommit).toBe(
      readFileSync(join(templateDir, 'FACTORY_COMMIT'), 'utf8').trim(),
    );
  });

  test('lists the holdout fence hook with the agents it admits', () => {
    const fence = parsed.hooks.find((h) => h.path === '.factory/hooks/holdout_fence.py');
    expect(fence).toBeDefined();
    expect([...(fence?.admittedAgents ?? [])].sort()).toEqual([
      'holdout-verifier',
      'holdout-writer',
    ]);
  });

  test('reads every text with LF line endings, as git stores it', () => {
    const texts = [
      ...parsed.workflows.map((w) => ({ path: w.file, text: w.yaml })),
      ...parsed.commands,
      ...parsed.scripts,
      ...parsed.hooks,
    ];
    expect(texts.length).toBeGreaterThan(0);
    expect(texts.filter((t) => t.text.includes('\r')).map((t) => t.path)).toEqual([]);
  });

  test('reads the commit pins without a CR', () => {
    const pins = [
      join(repoRoot, 'fixtures', 'pack', 'ARCHON_COMMIT'),
      join(templateDir, 'FACTORY_COMMIT'),
    ];
    expect(pins.filter((pin) => readFileSync(pin, 'utf8').includes('\r'))).toEqual([]);
    expect(parsed.archonCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(parsed.factoryCommit).toMatch(/^[0-9a-f]{40}$/);
  });

  test('parsing twice gives deep-equal output', () => {
    expect(parsePack(packDir, templateDir)).toEqual(parsed);
  });
});

describe('load refusal', () => {
  const made: string[] = [];
  afterEach(() => {
    for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** A pack of workflows by name, each a YAML `nodes:` list; parsed with an empty template. */
  function refusalOf(workflows: Record<string, string>): string | null {
    const root = mkdtempSync(join(tmpdir(), 'mc-refusal-'));
    made.push(root);
    for (const [name, nodes] of Object.entries(workflows)) {
      mkdirSync(join(root, 'sdlc', name), { recursive: true });
      writeFileSync(join(root, 'sdlc', name, `${name}.yaml`), `name: ${name}\nnodes:\n${nodes}`);
    }
    mkdirSync(join(root, 'template'));
    return loadRefusal(parsePack(join(root, 'sdlc'), join(root, 'template')).workflows);
  }

  const include = (name: string) => `  - id: inc\n    include: ${name}\n`;
  const leaf = '  - id: leaf\n    bash: echo\n';

  /** w0 includes w1, and so on down to `wN`, which runs a command. */
  function chain(includes: number): Record<string, string> {
    const workflows: Record<string, string> = {};
    for (let i = 0; i < includes; i++) workflows[`w${i}`] = include(`w${i + 1}`);
    workflows[`w${includes}`] = leaf;
    return workflows;
  }

  test('the fixture pack loads', () => {
    expect(loadRefusal(parsed.workflows)).toBeNull();
  });

  test('three nested includes load, as Archon allows', () => {
    expect(refusalOf(chain(3))).toBeNull();
  });

  test("a fourth nested include refuses its root, in Archon's words", () => {
    expect(refusalOf(chain(4))).toBe(
      'Archon would refuse to load workflow w0: include depth limit exceeded (max 3 levels): w0 -> w1 -> w2 -> w3 -> w4.',
    );
  });

  test('every refused workflow is counted', () => {
    expect(refusalOf({ ...chain(4), x0: include('w0') })).toBe(
      'Archon would refuse to load workflow w0 and 1 other: include depth limit exceeded (max 3 levels): w0 -> w1 -> w2 -> w3 -> w4.',
    );
  });

  test('a loop group adds no depth', () => {
    const grouped =
      '  - id: group\n    loop_group:\n      nodes:\n        - id: inc\n          include: w2\n';
    expect(refusalOf({ ...chain(4), w1: grouped })).toBe(
      'Archon would refuse to load workflow w0: include depth limit exceeded (max 3 levels): w0 -> w1 -> w2 -> w3 -> w4.',
    );
  });
});
