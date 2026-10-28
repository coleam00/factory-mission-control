import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { archonDb, snapshot } from '../db/test-db';
import { createGitHub, type GetFetch } from '../function/github';
import { BATCH, type History, inBatches, main, storeHistory } from './backfill';
import { REPO_ROOT } from './lib/cli';
import type { Db, Row } from './lib/db';
import { DATABASE_URL, NOW, recordingDeps, scratchRepo } from './lib/test-deps';
import { migrationsDir, readMigrationFiles, runMigrations } from './migrate';

/** GitHub's answers for every URL backfill reads, recorded as `{ link?, body }`. */
const responses: Record<string, { link?: string; body: unknown }> = JSON.parse(
  readFileSync(join(REPO_ROOT, 'fixtures', 'github', 'responses.json'), 'utf-8'),
);

/**
 * backfill reads the factories it follows from the committed factories.json; these tests follow
 * the one factory `responses` recorded, whatever that file lists, and give it back when done.
 */
const readJson = (path: string) => JSON.parse(readFileSync(join(REPO_ROOT, path), 'utf-8'));
mock.module('../factories.json', () => ({ default: readJson('fixtures/github/factories.json') }));
afterAll(() => {
  mock.module('../factories.json', () => ({ default: readJson('factories.json') }));
});

let db: Db;
let requests: { url: string; method: string }[];
const scratch: string[] = [];

beforeEach(async () => {
  db = await archonDb();
  await runMigrations({ files: readMigrationFiles(migrationsDir(REPO_ROOT)), db });
  requests = [];
});
afterEach(async () => {
  await db.close();
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const recorded: GetFetch = async (url, init) => {
  requests.push({ url, method: init.method });
  const response = responses[url];
  if (!response) throw new Error(`no recorded response for ${url}`);
  const { body, link } = response;
  return typeof body === 'string'
    ? new Response(body)
    : Response.json(body, { headers: link ? { link } : {} });
};

/** Runs the command against the recorded GitHub and the in-memory database, on `branchName`. */
async function run(argv: string[], branchName = 'check-abc', fetch = recorded) {
  const repoRoot = scratchRepo({ MC_DATABASE_URL: DATABASE_URL });
  scratch.push(repoRoot);
  const recorder = recordingDeps({ repoRoot, branchName });
  const deps = {
    ...recorder.deps,
    github: () => createGitHub(fetch),
    openDb: (url: string) => {
      recorder.opened.push(url);
      return { ...db, close: async () => {} };
    },
  };
  return { code: await main(argv, deps), ...recorder };
}

const rows = (sql: string, params: unknown[] = []): Promise<Row[]> => db.query(sql, params);

test('backfill on a check branch stores every recorded issue, comment, label, pull request, pin and decision', async () => {
  const { code, out } = await run([]);
  expect(code).toBe(0);
  expect(out).toEqual([
    'mission-control: 3 issues, 2 comments, 3 labels, 1 pull requests',
    'coleam00/ai-software-factory: 1 pins, 1 verdicts, 2 decisions',
  ]);
  expect(await rows('SELECT number, state FROM mc.issues ORDER BY number')).toEqual([
    { number: 10, state: 'open' },
    { number: 11, state: 'closed' },
    { number: 45, state: 'open' },
  ]);
  expect(await rows('SELECT issue_number, label FROM mc.issue_labels ORDER BY 1, 2')).toEqual([
    { issue_number: 10, label: 'enhancement' },
    { issue_number: 10, label: 'needs-owner' },
    { issue_number: 11, label: 'enhancement' },
  ]);
  expect(await rows('SELECT run_id FROM mc.claims')).toEqual([
    { run_id: 'a1ba5462-3544-481a-92b4-25c62ad62d17' },
  ]);
  expect(await rows('SELECT pr_number, outcome FROM mc.reviews')).toEqual([
    { pr_number: 34, outcome: 'merged' },
  ]);
  expect(await rows('SELECT pr_number, issue_number FROM mc.pull_request_issues')).toEqual([
    { pr_number: 34, issue_number: 10 },
  ]);
  expect(await rows('SELECT count(*)::int AS n FROM mc.metrics_lines')).toEqual([{ n: 1 }]);
  expect(await rows('SELECT archon_sha FROM mc.pins')).toEqual([
    { archon_sha: 'abd85896e7971c9ac5199ed7e87973f27130250f' },
  ]);
});

test('a pin whose pack file pins another version is written without a sha, said so, with the rest', async () => {
  const other = 'f'.repeat(40);
  const repinned: GetFetch = (url, init) =>
    url.includes('/contents/template/factory/pack.json')
      ? Promise.resolve(Response.json({ integration_revision_required: other }))
      : recorded(url, init);
  const { code, out } = await run([], 'check-abc', repinned);
  expect(code).toBe(0);
  expect(out).toEqual([
    'mission-control: 3 issues, 2 comments, 3 labels, 1 pull requests',
    'coleam00/ai-software-factory: 1 pins, 1 verdicts, 2 decisions',
    `pin without an Archon sha 85d479ad: pins ${other}, not abd85896`,
  ]);
  expect(await rows('SELECT archon_sha FROM mc.pins')).toEqual([{ archon_sha: null }]);
});

test('every request backfill and reconcile send to GitHub is a GET, the next page included', async () => {
  await run([]);
  await run(['--reconcile']);
  expect(requests.map((r) => r.url)).toEqual([
    ...Object.keys(responses),
    ...Object.keys(responses),
  ]);
  expect(requests.filter((r) => r.method !== 'GET')).toEqual([]);
});

test('running backfill twice changes nothing the second time', async () => {
  await run([]);
  const first = await snapshot(db);
  expect((await run([])).code).toBe(0);
  expect(await snapshot(db)).toEqual(first);
});

test('reconcile removes a stored label, issue and comment GitHub no longer has; a second reconcile changes no row', async () => {
  await run([]);
  await rows(`INSERT INTO mc.issue_labels VALUES ('mission-control', 10, 'stale')`);
  await rows(
    `INSERT INTO mc.issues (factory, number, title, state, url, created_at, updated_at)
      VALUES ('mission-control', 99, 'gone', 'open', 'u', $1, $1)`,
    ['2026-10-01T00:00:00Z'],
  );
  await rows(
    `INSERT INTO mc.owner_questions (factory, issue_number, question_number, question, raised_at)
      VALUES ('mission-control', 99, 1, 'q', $1)`,
    ['2026-10-01T00:00:00Z'],
  );
  await rows(
    `INSERT INTO mc.comments (factory, id, issue_number, author, url, created_at, updated_at)
      VALUES ('mission-control', 1, 10, 'a', 'u', $1, $1)`,
    ['2026-10-01T00:00:00Z'],
  );

  const { code, out } = await run(['--reconcile']);
  expect(code).toBe(0);
  expect(out[0]).toBe('removed 1 issue(s) and 1 comment(s)');
  expect(
    await rows('SELECT label FROM mc.issue_labels WHERE issue_number = 10 ORDER BY 1'),
  ).toEqual([{ label: 'enhancement' }, { label: 'needs-owner' }]);
  expect(await rows('SELECT number FROM mc.issues WHERE number = 99')).toEqual([]);
  expect(await rows('SELECT id FROM mc.comments WHERE id = 1')).toEqual([]);
  expect(await rows('SELECT closed_at FROM mc.owner_questions WHERE issue_number = 99')).toEqual([
    { closed_at: NOW },
  ]);

  const repaired = await snapshot(db);
  const again = await run(['--reconcile']);
  expect(again.out[0]).toBe('removed 0 issue(s) and 0 comment(s)');
  expect(await snapshot(db)).toEqual(repaired);
});

test('reconcile keeps an issue and comment the webhook stored after reading GitHub began', async () => {
  await run([]);
  const after = new Date(NOW.getTime() + 1000).toISOString();
  await rows(
    `INSERT INTO mc.issues (factory, number, title, state, url, created_at, updated_at)
      VALUES ('mission-control', 98, 'new', 'open', 'u', $1, $1)`,
    [after],
  );
  await rows(
    `INSERT INTO mc.comments (factory, id, issue_number, author, url, created_at, updated_at)
      VALUES ('mission-control', 2, 98, 'a', 'u', $1, $1)`,
    [after],
  );

  const { out } = await run(['--reconcile']);
  expect(out[0]).toBe('removed 0 issue(s) and 0 comment(s)');
  expect(await rows('SELECT number FROM mc.issues WHERE number = 98')).toEqual([{ number: 98 }]);
  expect(await rows('SELECT id FROM mc.comments WHERE id = 2')).toEqual([{ id: 2 }]);
});

test.each([[[]], [['--reconcile']]])(
  'given no DECISIONS.md on GitHub, %j exits non-zero and writes nothing',
  async (argv) => {
    await run([]);
    const before = await snapshot(db);
    const missing: GetFetch = (url, init) =>
      url.includes('/contents/DECISIONS.md')
        ? Promise.resolve(new Response('', { status: 404 }))
        : recorded(url, init);
    const { code, err } = await run(argv, 'check-abc', missing);
    expect(code).toBe(1);
    expect(err.join('\n')).toContain('has no DECISIONS.md');
    expect(await snapshot(db)).toEqual(before);
  },
);

test('reconcile closes an issue GitHub closed', async () => {
  await rows(
    `INSERT INTO mc.issues (factory, number, title, state, url, created_at, updated_at)
      VALUES ('mission-control', 11, 't', 'open', 'u', $1, $1)`,
    ['2026-10-25T00:04:10Z'],
  );
  await run(['--reconcile']);
  expect(await rows('SELECT state, closed_at FROM mc.issues WHERE number = 11')).toEqual([
    { state: 'closed', closed_at: new Date('2026-10-26T09:00:00Z') },
  ]);
});

test.each([[[]], [['--reconcile']]])(
  'given target branch main, %j exits non-zero, reads nothing and writes nothing',
  async (argv) => {
    const before = await snapshot(db);
    const { code, opened, err } = await run(argv, 'main');
    expect(code).not.toBe(0);
    expect(err.join('\n')).toContain(`refusing branch 'main'`);
    expect(opened).toEqual([]);
    expect(requests).toEqual([]);
    expect(await snapshot(db)).toEqual(before);
  },
);

test.each([[['--main']], [['--reconcile', '--main']]])(
  '%j refuses a check branch and writes main',
  async (argv) => {
    const refused = await run(argv, 'check-abc');
    expect(refused.code).not.toBe(0);
    expect(refused.opened).toEqual([]);
    expect(requests).toEqual([]);

    const written = await run(argv, 'main');
    expect(written.code).toBe(0);
    expect(written.opened).toEqual([DATABASE_URL]);
  },
);

test('an unknown argument exits 2 with usage before touching Neon', async () => {
  const { code, err, neonCalls } = await run(['--force']);
  expect(code).toBe(2);
  expect(err.join('\n')).toContain('usage: bun run backfill');
  expect(neonCalls).toEqual([]);
});

test('no transaction is open while GitHub is asked, and each writes at most BATCH items (#260)', async () => {
  let open = 0;
  const transactions: string[][] = [];
  const askedInTransaction: string[] = [];
  const watched: GetFetch = async (url, init) => {
    if (open > 0) askedInTransaction.push(url);
    return recorded(url, init);
  };
  const repoRoot = scratchRepo({ MC_DATABASE_URL: DATABASE_URL });
  scratch.push(repoRoot);
  const recorder = recordingDeps({ repoRoot, branchName: 'check-abc' });
  const deps = {
    ...recorder.deps,
    github: () => createGitHub(watched),
    openDb: (): Db => ({
      ...db,
      async transaction(fn) {
        const statements: string[] = [];
        transactions.push(statements);
        open++;
        try {
          await db.transaction((tx) =>
            fn({
              query: (text, params) => {
                statements.push(text);
                return tx.query(text, params);
              },
            }),
          );
        } finally {
          open--;
        }
      },
      close: async () => {},
    }),
  };

  for (const argv of [[], ['--reconcile']]) {
    expect(await main(argv, deps)).toBe(0);
  }
  expect(askedInTransaction).toEqual([]);
  expect(requests.length).toBeGreaterThan(0);
  // Writes are split by kind and batch, never one transaction for the whole run.
  expect(transactions.length).toBeGreaterThan(2);
  const upsertsOf = (statements: string[], table: string) =>
    statements.filter((s) => s.replace(/\s+/g, ' ').includes(`INSERT INTO ${table} (`)).length;
  // The counting below sees the writes it bounds.
  expect(transactions.reduce((n, t) => n + upsertsOf(t, 'mc.issues'), 0)).toBeGreaterThan(0);
  for (const statements of transactions) {
    for (const table of ['mc.issues', 'mc.comments', 'mc.pull_requests', 'mc.pins']) {
      const upserts = upsertsOf(statements, table);
      expect(upserts).toBeLessThanOrEqual(BATCH);
    }
  }
});

test('a history larger than one batch is written in several transactions, rows unchanged', async () => {
  let transactions = 0;
  const counting = (): Db => ({
    ...db,
    transaction: (fn) => {
      transactions++;
      return db.transaction(fn);
    },
    close: async () => {},
  });
  const history = {
    factories: [
      {
        factory: 'mission-control',
        issues: Array.from({ length: BATCH * 2 + 1 }, (_, i) => ({
          number: 1000 + i,
          title: `batched ${i}`,
          state: 'open',
          html_url: `https://github.com/o/r/issues/${1000 + i}`,
          created_at: '2026-10-01T00:00:00Z',
          updated_at: '2026-10-01T00:00:00Z',
          labels: [],
        })),
        comments: [],
        pullRequests: [],
      },
    ],
    commits: [],
    unresolvedPins: [],
    decisions: '',
  } as unknown as History;
  await storeHistory(counting(), history);
  // Three batches of issues, then the decisions file.
  expect(transactions).toBe(4);
  expect(
    Number(
      (await rows(`SELECT count(*)::int AS n FROM mc.issues WHERE title LIKE 'batched %'`))[0]?.n,
    ),
  ).toBe(BATCH * 2 + 1);
});

test('a batch commits once it has been open its time limit, even short of its count', async () => {
  const batches: number[][] = [];
  const fake: Db = {
    ...db,
    transaction: async (fn) => {
      batches.push([]);
      await fn({ query: async () => [] });
    },
    close: async () => {},
  };
  // Each write takes ~30 ms; a 50 ms limit closes a batch after its second or third item.
  await inBatches(
    fake,
    Array.from({ length: 10 }, (_, i) => i),
    async (_tx, item) => {
      batches.at(-1)?.push(item);
      await Bun.sleep(30);
    },
    { count: 25, ms: 50 },
  );
  expect(batches.flat()).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  expect(batches.length).toBeGreaterThanOrEqual(3);
  for (const batch of batches) expect(batch.length).toBeLessThanOrEqual(3);
});
