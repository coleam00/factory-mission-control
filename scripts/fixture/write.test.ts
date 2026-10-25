import { afterEach, expect, test } from 'bun:test';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../lib/cli';
import { DATABASE_URL, NOW, recordingDeps, scratchRepo } from '../lib/test-deps';
import { eventData, main, structuredOutputFor } from './write';

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function repo(): string {
  const dir = scratchRepo({ MC_DATABASE_URL: DATABASE_URL });
  scratch.push(dir);
  return dir;
}

test.each(['main', 'fixture', 'rewind-x'])(
  'refuses a database URL on branch %s without connecting',
  async (branchName) => {
    const run = recordingDeps({ repoRoot: repo(), branchName });
    expect(await main(['step'], run.deps)).not.toBe(0);
    expect(run.mutatingCalls).toEqual([]);
    expect(run.opened).toEqual([]);
    expect(run.err.join('\n')).toContain(`refusing branch '${branchName}'`);
  },
);

test.each([[['label']], [['step', '--event', 'workflow_started']], [[]]])(
  'exits 2 with usage for %j before touching Neon',
  async (argv) => {
    const run = recordingDeps({ repoRoot: repo() });
    expect(await main(argv, run.deps)).toBe(2);
    expect(run.neonCalls).toEqual([]);
    expect(run.err.join('\n')).toContain('usage: bun run fixture:write step');
  },
);

test('inserts one event into a new running archon-loop run when the branch has none', async () => {
  let events = 0;
  const run = recordingDeps({
    repoRoot: repo(),
    rows: (sql) => {
      if (sql.startsWith('SELECT id FROM remote_agent_workflow_runs')) return [];
      if (sql.startsWith('INSERT INTO remote_agent_workflow_runs')) return [{ id: 'run-1' }];
      if (sql.startsWith('INSERT INTO remote_agent_workflow_events')) events++;
      if (sql.startsWith('SELECT count(*)')) return [{ n: events }];
      return [];
    },
  });
  expect(await main(['step', '--step', 'review'], run.deps)).toBe(0);
  expect(run.out).toEqual(['events for run run-1: 0 -> 1']);
  expect(run.sql.filter((sql) => sql.startsWith('INSERT'))).toHaveLength(2);
});

type Schema = {
  required?: string[];
  properties?: Record<string, Schema>;
  items?: Schema;
};

const loop = Bun.YAML.parse(
  readFileSync(join(REPO_ROOT, 'fixtures', 'pack', 'sdlc', 'loop', 'archon-loop.yaml'), 'utf-8'),
) as { nodes: { id: string; output_format?: Schema }[] };

test.each(['pick', 'check-app', 'review', 'land'])(
  "%s's structured output has exactly the keys the pinned pack requires",
  (step) => {
    const schema = loop.nodes.find((node) => node.id === step)?.output_format;
    const output = structuredOutputFor(step);
    expect(schema?.required).toBeDefined();
    expect(Object.keys(output ?? {}).sort()).toEqual([...(schema?.required ?? [])].sort());
    const lineKeys = schema?.properties?.lines?.items?.required;
    for (const line of (output?.lines as Record<string, unknown>[] | undefined) ?? []) {
      expect(Object.keys(line).sort()).toEqual([...(lineKeys ?? [])].sort());
    }
  },
);

test('a completed event carries the structured output and its JSON text', () => {
  const data = eventData('pick', 'node_completed', NOW);
  expect(data.structured_output).toEqual(structuredOutputFor('pick'));
  expect(JSON.parse(String(data.node_output))).toEqual(structuredOutputFor('pick'));
});
