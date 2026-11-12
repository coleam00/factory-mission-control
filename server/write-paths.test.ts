/**
 * PRD invariant 2: the dashboard writes to a factory in exactly five ways, all in
 * `server/actions.ts`. This scans the dashboard's own code and fails on any other process spawn,
 * network call, Archon write verb, SQL write to Archon's tables, or GitHub/Archon client library.
 * A new entry below is for a path that does not write to GitHub, Archon or a factory, with its reason.
 *
 * Not scanned: `.archon/`, `factory/` and `.factory/` (the factory package the dashboard watches,
 * not the dashboard), `harness/` (the app check's driver) and `fixtures/` (data).
 */
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const repoRoot = resolve(import.meta.dir, '..');
const ROOTS = ['app', 'server', 'function', 'parsers', 'db', 'scripts'];

const tracked = (await Bun.$`git ls-files ${ROOTS}`.cwd(repoRoot).text())
  .split('\n')
  .filter((file) => /\.(ts|tsx|js|sql)$/.test(file) && !/\.test\.|\.browser\.test\./.test(file));
const sources = new Map(
  tracked.map((file) => [file, readFileSync(resolve(repoRoot, file), 'utf-8')]),
);

const matching = (pattern: RegExp) =>
  [...sources].filter(([, text]) => pattern.test(text)).map(([file]) => file);
const remedy =
  'Add a reasoned entry only for a path that writes to neither GitHub, Archon nor a factory.';

const SPAWN_SITES: Record<string, string> = {
  'server/actions.ts': 'the five writes',
  'server/build-id.ts': 'git rev-parse',
  'server/manager.ts': 'the Manager agent: read-only tools, proven by manager-tools.test.ts',
  'scripts/lib/archon-run.ts': 'workflow get, read',
  'scripts/lib/cdp.ts': 'headless Chrome',
  'scripts/lib/cli.ts': "runs this repository's own scripts",
  'scripts/idle-check.ts': 'runs the local function',
  'scripts/live/shared.ts': 'bun run fixture:write on a check branch',
  'scripts/live/switcher.ts': 'serves the app',
  'scripts/test-live.ts': 'serves the app',
};

const FETCH_SITES: Record<string, string> = {
  'app/lib/actions.ts': 'same-origin /api/',
  'app/lib/manager.ts': 'same-origin /api/',
  'app/lib/rewind.ts': 'same-origin /api/',
  'app/live/LivePanel.tsx': 'same-origin /api/',
  'app/live/LiveProvider.tsx': 'same-origin /api/',
  'function/github.ts': 'GET only',
  'scripts/lib/github.ts': 'GET only',
  'scripts/lib/neon.ts': 'the Neon API: database branches, not GitHub, Archon or a factory',
  'scripts/lib/cli.ts': 'passes the real fetch to its dependants',
  'scripts/idle-check.ts': 'the local function',
  'scripts/live/shared.ts': 'the local app',
  'scripts/live/switcher.ts': 'the local app',
};

const ARCHON_FIXTURE_WRITERS: Record<string, string> = {
  'scripts/fixture/write.ts':
    'fixture:write, connects only through guardedDatabaseUrl(deps, "check")',
  'scripts/fixture/seed-laps.ts': 'generates the SQL fixture:write runs on a check branch',
  'scripts/test-live.ts': 'connects only through guardedDatabaseUrl(deps, "check")',
  'scripts/projection-locks.ts': 'connects only through guardedDatabaseUrl(deps, "check")',
  'scripts/live/board.ts': 'a phase test-live.ts runs on its guarded check branch',
  'scripts/live/queue-map.ts': 'a phase test-live.ts runs on its guarded check branch',
  'scripts/live/work-item.ts': 'a phase test-live.ts runs on its guarded check branch',
};

const SPAWN =
  /Bun\.spawn|Bun\.spawnSync|Bun\.\$|node:child_process|from 'child_process'|@anthropic-ai\/claude-agent-sdk/;
const FETCH_CALL = /(^|[^\w.])(fetch|fetchImpl|doFetch)\(/m;
const ARCHON_WRITE = /(INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE)\s+(public\.)?"?remote_agent_/i;
const ARCHON_VERBS = [
  'answer',
  'resume',
  'forge',
  'workitem.label.add',
  'workitem.close',
  'workitem.comment.upsert',
  'approve',
  'reject',
  'respond',
  'cancel',
  'abandon',
  'signal',
  'end-turn',
  'wake',
  'cleanup',
  'reset-sessions',
];

test('only the listed files spawn a process', () => {
  expect(matching(SPAWN).sort(), remedy).toEqual(Object.keys(SPAWN_SITES).sort());
});

// The Manager's own 'answer' and 'resume' are proposal kinds it streams, not argv: it spawns the agent SDK, not a CLI.
// 'run' is not listed: scripts/live/shared.ts and scripts/test-live.ts spawn `bun run`.
test('no CLI spawn site outside server/actions.ts names an Archon write or pushes to GitHub', () => {
  const quoted = new RegExp(`['"\`](${[...ARCHON_VERBS, 'gh', 'push'].join('|')})['"\`]`);
  const offenders = matching(
    /Bun\.spawn|Bun\.spawnSync|Bun\.\$|node:child_process|from 'child_process'/,
  ).filter((file) => file !== 'server/actions.ts' && quoted.test(sources.get(file) ?? ''));
  expect(offenders, 'a spawn site names an Archon write verb, gh or push').toEqual([]);
});

test('server/actions.ts sends exactly the five writes', () => {
  const text = sources.get('server/actions.ts') ?? '';
  const operations = [...text.matchAll(/['"`](workitem\.[\w.]+)['"`]/g)].map((m) => m[1]);
  expect([...new Set(operations)].sort()).toEqual([
    'workitem.close',
    'workitem.comment.upsert',
    'workitem.label.add',
  ]);
  const verbs = [...text.matchAll(/'workflow',\s*'([\w-]+)'/g)].map((m) => m[1]);
  expect([...new Set(verbs)].sort()).toEqual(['answer', 'resume', 'run']);
});

test('the operator command is read in one place', () => {
  const holders = matching(/operators\.json|MC_OPERATORS_FILE|loadOperators|actionsFromEnv/);
  expect(holders.sort()).toEqual(['server/actions.ts', 'server/main.ts']);
});

test('only the listed files make network calls, and the browser only calls its own /api/', () => {
  expect(matching(FETCH_CALL).sort(), remedy).toEqual(Object.keys(FETCH_SITES).sort());
  for (const [file, text] of sources) {
    if (!file.startsWith('app/')) continue;
    for (const call of text.matchAll(/(?:^|[^\w.])(?:fetch|fetchImpl)\(\s*(['"`/][^,)]*)/gm)) {
      expect(call[1], `${file} calls something other than its own /api/`).toMatch(/^['"`]\/api\//);
    }
  }
  for (const file of matching(/api\.github\.com/)) {
    if (file === 'db/run-stops-corpus.ts') continue; // sample error text, not a call
    expect(['function/github.ts', 'scripts/lib/github.ts']).toContain(file);
    expect(sources.get(file), `${file} writes to GitHub`).not.toMatch(
      /method: '(POST|PUT|PATCH|DELETE)'/,
    );
  }
});

test("nothing writes Archon's tables except the check-branch fixture tooling", () => {
  expect(matching(ARCHON_WRITE).sort(), remedy).toEqual(Object.keys(ARCHON_FIXTURE_WRITERS).sort());
});

test('no GitHub or Archon client library is imported', () => {
  expect(matching(/from '@octokit\/|from '@archon\/|require\('@octokit|require\('@archon/)).toEqual(
    [],
  );
});
