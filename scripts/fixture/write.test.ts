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

/** A database with no running run that stores jsonb as `stored` reports, counting events. */
function storing(stored: string) {
  let events = 0;
  return (sql: string) => {
    if (sql.startsWith('SELECT id FROM remote_agent_workflow_runs')) return [];
    if (sql.startsWith('INSERT INTO remote_agent_workflow_runs')) return [{ id: 'run-1', stored }];
    if (sql.startsWith('INSERT INTO remote_agent_workflow_events')) {
      events++;
      return [{ stored }];
    }
    if (sql.startsWith('SELECT count(*)')) return [{ n: events }];
    return [];
  };
}

test('inserts one event into a new running archon-loop run when the branch has none', async () => {
  const run = recordingDeps({ repoRoot: repo(), rows: storing('object') });
  expect(await main(['step', '--step', 'review'], run.deps)).toBe(0);
  expect(run.out).toEqual(['events for run run-1: 0 -> 1']);
  expect(run.sql.filter((sql) => sql.startsWith('INSERT'))).toHaveLength(2);
});

test('binds the run metadata and the event data as objects, not JSON text', async () => {
  const run = recordingDeps({ repoRoot: repo(), rows: storing('object') });
  expect(await main(['step', '--step', 'pick'], run.deps)).toBe(0);
  const bound = (prefix: string) => run.params[run.sql.findIndex((sql) => sql.startsWith(prefix))];
  expect(bound('INSERT INTO remote_agent_workflow_runs')?.[2]).toEqual({
    workflow_source: { digest: expect.stringMatching(/^sha256:/) },
  });
  expect(bound('INSERT INTO remote_agent_workflow_events')?.[3]).toEqual(
    eventData('pick', 'node_completed', NOW),
  );
});

test.each(['string', 'array'])(
  'fails when the database stores the jsonb as a %s',
  async (stored) => {
    const run = recordingDeps({ repoRoot: repo(), rows: storing(stored) });
    expect(await main(['step'], run.deps)).toBe(1);
    expect(run.err.join('\n')).toContain(`stored as a jsonb ${stored}, not an object`);
    expect(run.out).toEqual([]);
  },
);

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
