import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../lib/cli';
import { DATABASE_URL, NOW, recordingDeps, scratchRepo } from '../lib/test-deps';
import { attentionWait, eventData, main, structuredOutputFor } from './write';

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

test.each([
  [['nope']],
  [['step', '--event', 'workflow_started']],
  [['pin', '--step', 'pick']],
  [['label', '--error', 'ECONNRESET']],
  [['step', '--error', 'ECONNRESET']],
  [[]],
])('exits 2 with usage for %j before touching Neon', async (argv) => {
  const run = recordingDeps({ repoRoot: repo() });
  expect(await main(argv, run.deps)).toBe(2);
  expect(run.neonCalls).toEqual([]);
  expect(run.err.join('\n')).toContain('usage: bun run fixture:write step');
});

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

test('a failed event carries the error --error names', async () => {
  const run = recordingDeps({ repoRoot: repo(), rows: storing('object') });
  const argv = ['step', '--step', 'deploy', '--event', 'node_failed', '--error', 'ECONNRESET'];
  expect(await main(argv, run.deps)).toBe(0);
  const bound =
    run.params[
      run.sql.findIndex((sql) => sql.startsWith('INSERT INTO remote_agent_workflow_events'))
    ];
  expect(bound?.[3]).toEqual(eventData('deploy', 'node_failed', NOW, 'ECONNRESET'));
  expect(bound?.[3]).toMatchObject({ error: 'ECONNRESET' });
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

const ROW_KINDS = [
  ['label', 'mc.issue_labels'],
  ['comment', 'mc.comments'],
  ['issue', 'mc.issues'],
  ['pin', 'mc.pins'],
  ['verdict', 'mc.verdicts'],
  ['decision', 'mc.decisions'],
] as const;

/** A table holding `before` rows, then `after` once something is inserted. */
function counting(before: number, after: number) {
  let inserted = false;
  return (sql: string) => {
    if (sql.startsWith('INSERT')) {
      inserted = true;
      return [{ written: 1 }];
    }
    if (sql.startsWith('SELECT count(*)')) return [{ n: inserted ? after : before }];
    return [];
  };
}

describe.each(ROW_KINDS)('the %s kind', (kind, table) => {
  test.each(['main', 'fixture', 'rewind-x'])(
    'refuses branch %s without connecting',
    async (branchName) => {
      const run = recordingDeps({ repoRoot: repo(), branchName });
      expect(await main([kind], run.deps)).toBe(1);
      expect(run.opened).toEqual([]);
      expect(run.err.join('\n')).toContain(`refusing branch '${branchName}'`);
    },
  );

  test(`inserts exactly one row into ${table} on a check branch`, async () => {
    const run = recordingDeps({ repoRoot: repo(), rows: counting(3, 4) });
    expect(await main([kind], run.deps)).toBe(0);
    const inserts = run.sql.filter((sql) => sql.startsWith('INSERT'));
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toStartWith(`INSERT INTO ${table} (`);
    expect(run.out).toEqual([`${table} rows: 3 -> 4`]);
  });

  test('fails when the table did not gain a row', async () => {
    const run = recordingDeps({ repoRoot: repo(), rows: counting(3, 3) });
    expect(await main([kind], run.deps)).toBe(1);
    expect(run.err.join('\n')).toContain(`${table} rows: 3 -> 3, not one more`);
    expect(run.out).toEqual([]);
  });
});

test('binds every value a row kind writes, taken from the moment it runs', async () => {
  const run = recordingDeps({ repoRoot: repo(), rows: counting(0, 1) });
  expect(await main(['pin'], run.deps)).toBe(0);
  const params = run.params[run.sql.findIndex((sql) => sql.startsWith('INSERT'))];
  expect(params).toEqual([
    expect.stringMatching(/^[0-9a-f]{40}$/),
    expect.stringMatching(/^[0-9a-f]{40}$/),
    `fixture pin written at ${NOW.toISOString()}`,
    expect.any(String),
    expect.any(String),
    NOW.toISOString(),
  ]);
});

test('a verdict judges the pin --pin names by prefix, and --pin is refused anywhere else', async () => {
  const run = recordingDeps({ repoRoot: repo(), rows: counting(1, 2) });
  expect(await main(['verdict', '--pin', '5ffd60c6'], run.deps)).toBe(0);
  const at = run.sql.findIndex((sql) => sql.startsWith('INSERT'));
  expect(run.sql[at]).toContain("p.sha LIKE $4::text || '%'");
  expect(run.params[at]?.[3]).toBe('5ffd60c6');

  const latest = recordingDeps({ repoRoot: repo(), rows: counting(1, 2) });
  expect(await main(['verdict'], latest.deps)).toBe(0);
  expect(latest.params[latest.sql.findIndex((sql) => sql.startsWith('INSERT'))]?.[3]).toBeNull();

  for (const argv of [
    ['pin', '--pin', '5ffd60c6'],
    ['step', '--pin', '5ffd60c6'],
    ['verdict', '--pin', 'V2'],
  ]) {
    const refused = recordingDeps({ repoRoot: repo() });
    expect(await main(argv, refused.deps)).toBe(2);
    expect(refused.opened).toEqual([]);
  }
});

describe('the attention kind', () => {
  test('pauses the one running run it names on an open attention wait', async () => {
    const run = recordingDeps({ repoRoot: repo(), rows: () => [{ id: 'run-1' }] });
    expect(await main(['attention', '--run', 'run-1'], run.deps)).toBe(0);
    expect(run.out).toEqual(['run run-1: running -> paused on attention']);
    const at = run.sql.findIndex((sql) => sql.startsWith('UPDATE remote_agent_workflow_runs'));
    expect(run.sql[at]).toContain("status = 'running'");
    expect(run.params[at]?.[0]).toBe('run-1');
    expect(run.params[at]?.[1]).toEqual(attentionWait(NOW.toISOString()));
  });

  test('refuses a run that is not running, and a missing --run', async () => {
    const none = recordingDeps({ repoRoot: repo(), rows: () => [] });
    expect(await main(['attention', '--run', 'run-1'], none.deps)).toBe(1);
    expect(none.err.join('\n')).toContain('run run-1 is not a running run');
    const bare = recordingDeps({ repoRoot: repo() });
    expect(await main(['attention'], bare.deps)).toBe(2);
    expect(bare.opened).toEqual([]);
  });
});

describe('the retriage kind', () => {
  test('sets the one state row it names to now and bumps its revision', async () => {
    const run = recordingDeps({ repoRoot: repo(), rows: () => [{ number: 413 }] });
    expect(await main(['retriage', '--issue', '413'], run.deps)).toBe(0);
    expect(run.out).toEqual(['work item #413: re-triaged']);
    const at = run.sql.findIndex((sql) => sql.startsWith('UPDATE mc.work_item_states'));
    expect(run.params[at]).toEqual([413, NOW.toISOString()]);
  });

  test('refuses a work item with no state row, and anything but --issue', async () => {
    const none = recordingDeps({ repoRoot: repo(), rows: () => [] });
    expect(await main(['retriage', '--issue', '9'], none.deps)).toBe(1);
    expect(none.err.join('\n')).toContain('0 work item states for #9');
    for (const argv of [
      ['retriage'],
      ['retriage', '--issue', 'x'],
      ['retriage', '--issue', '9', '--label', 'a'],
    ]) {
      const refused = recordingDeps({ repoRoot: repo() });
      expect(await main(argv, refused.deps)).toBe(2);
      expect(refused.opened).toEqual([]);
    }
  });
});

test('label writes needs-owner unless --label names another, and --issue names the issue; both are refused where they do not apply', async () => {
  const insertedLabel = async (argv: string[]) => {
    const run = recordingDeps({ repoRoot: repo(), rows: counting(1, 2) });
    expect(await main(argv, run.deps)).toBe(0);
    return run.params[run.sql.findIndex((sql) => sql.startsWith('INSERT'))]?.[2];
  };
  expect(await insertedLabel(['label'])).toBe('needs-owner');
  expect(await insertedLabel(['label', '--label', 'work-order:demo'])).toBe('work-order:demo');
  const named = recordingDeps({ repoRoot: repo(), rows: counting(1, 2) });
  expect(await main(['label', '--issue', '9'], named.deps)).toBe(0);
  const at = named.sql.findIndex((sql) => sql.startsWith('INSERT'));
  expect(named.params[at]?.[3]).toBe(9);

  for (const argv of [
    ['issue', '--label', 'work-order:demo'],
    ['step', '--label', 'work-order:demo'],
    ['label', '--label', ''],
    ['label', '--label', ' demo'],
    ['pin', '--issue', '9'],
    ['step', '--issue', '9'],
    ['label', '--issue', 'nine'],
    ['label', '--issue', '0'],
  ]) {
    const refused = recordingDeps({ repoRoot: repo() });
    expect(await main(argv, refused.deps)).toBe(2);
    expect(refused.opened).toEqual([]);
  }
});

describe('the metrics kind', () => {
  test('writes one completed archon-metrics-prs run whose prs node carries the fixture records', async () => {
    let metricRows = 0;
    const run = recordingDeps({
      repoRoot: repo(),
      rows: (sql) => {
        if (sql.startsWith('SELECT count(*)')) return [{ n: metricRows }];
        if (sql.startsWith('INSERT INTO remote_agent_workflow_runs')) return [{ id: 'run-1' }];
        if (sql.startsWith('INSERT INTO remote_agent_workflow_events')) {
          metricRows += 5;
          return [{ stored: 'object' }];
        }
        return [];
      },
    });
    expect(await main(['metrics'], run.deps)).toBe(0);
    expect(run.out).toEqual(['mc.metric_records rows: 0 -> 10']);
    const completed = run.sql.findLastIndex((sql) =>
      sql.startsWith('INSERT INTO remote_agent_workflow_events'),
    );
    expect(run.params[completed]?.[2]).toMatchObject({
      type: 'script',
      structured_output: {
        metrics: expect.arrayContaining([expect.objectContaining({ name: 'sdlc.pr_merge_rate' })]),
      },
    });
  });

  test('fails when the factory’s codebase is missing or no record was projected, and takes no option', async () => {
    const missing = recordingDeps({
      repoRoot: repo(),
      rows: (sql) => (sql.startsWith('SELECT count(*)') ? [{ n: 0 }] : []),
    });
    expect(await main(['metrics'], missing.deps)).toBe(1);
    expect(missing.err.join('\n')).toContain('no codebase named');
    const none = recordingDeps({
      repoRoot: repo(),
      rows: (sql) =>
        sql.startsWith('SELECT count(*)')
          ? [{ n: 0 }]
          : sql.startsWith('INSERT INTO remote_agent_workflow_runs')
            ? [{ id: 'run-1' }]
            : [{ stored: 'object' }],
    });
    expect(await main(['metrics'], none.deps)).toBe(1);
    expect(none.err.join('\n')).toContain('none added');
    const refused = recordingDeps({ repoRoot: repo() });
    expect(await main(['metrics', '--pin', 'abcd'], refused.deps)).toBe(2);
    expect(refused.opened).toEqual([]);
  });
});
