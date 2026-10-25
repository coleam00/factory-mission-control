import { afterEach, beforeEach, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { testDb } from '../db/test-db';
import factories from '../factories.json';
import type { Db, Row } from '../scripts/lib/db';
import { migrationsDir, readMigrationFiles, runMigrations } from '../scripts/migrate';
import { createWebhookApp } from './app';
import { createGitHub, type GetFetch } from './github';
import { sign, verify } from './signature';

const repoRoot = resolve(import.meta.dir, '..');
const fixtures = join(repoRoot, 'fixtures', 'webhooks');
const SECRET = 'test';

interface Delivery {
  file: string;
  event: string;
  delivery: string;
  signature: string;
}

const deliveries: Delivery[] = JSON.parse(readFileSync(join(fixtures, 'deliveries.json'), 'utf-8'));
const bytes = (file: string) => new Uint8Array(readFileSync(join(fixtures, file)));
const named = (prefix: string) => {
  const found = deliveries.find((d) => d.file.startsWith(prefix));
  if (!found) throw new Error(`no fixture ${prefix}`);
  return found;
};

const DECISIONS = `# Decisions

## 2026-10-24 Holdouts live in the repository, behind a hook
Decision: Holdout scenarios live in the repository.
Why: Builder steps read them.
Replaces: Holdout files kept outside the repository.
Version: abd85896
`;

type Request = { url: string; method: string };

let db: Db;
let requests: Request[];
let app: ReturnType<typeof createWebhookApp>;

beforeEach(async () => {
  db = testDb();
  await runMigrations({ files: readMigrationFiles(migrationsDir(repoRoot)), db });
  requests = [];
  const fetch: GetFetch = async (url, init) => {
    requests.push({ url, method: init.method });
    return new Response(DECISIONS);
  };
  app = createWebhookApp({
    secret: SECRET,
    db,
    factories: factories.factories,
    github: createGitHub(fetch),
  });
});
afterEach(() => db.close());

function post(
  event: string,
  body: Uint8Array<ArrayBuffer>,
  signature: string | null,
): Promise<Response> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-github-event': event,
  };
  if (signature !== null) headers['x-hub-signature-256'] = signature;
  return Promise.resolve(app.request('/', { method: 'POST', headers, body }));
}

const deliver = (d: Delivery) => post(d.event, bytes(d.file), d.signature);

/** Every row of every table in `mc`, so a comparison sees any change at all. */
async function snapshot(): Promise<Record<string, string[]>> {
  const tables = await db.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'mc' AND table_type = 'BASE TABLE' ORDER BY table_name`,
  );
  const all: Record<string, string[]> = {};
  for (const { table_name } of tables) {
    const rows = await db.query(
      `SELECT to_jsonb(t)::text AS row FROM mc.${String(table_name)} t ORDER BY 1`,
      [],
    );
    all[String(table_name)] = rows.map((r) => String(r.row));
  }
  return all;
}

const rows = (sql: string, params: unknown[] = []): Promise<Row[]> => db.query(sql, params);

test('every fixture is signed with secret `test` over its exact bytes', async () => {
  for (const d of deliveries) {
    const body = bytes(d.file);
    expect({ file: d.file, signature: d.signature }).toEqual({
      file: d.file,
      signature: await sign(SECRET, body),
    });
    expect(await verify(SECRET, body, d.signature)).toBe(true);
  }
  expect(new Set(deliveries.map((d) => d.event))).toEqual(
    new Set(['issues', 'issue_comment', 'label', 'pull_request', 'push']),
  );
});

test('each fixture returns 2xx and writes the rows it names', async () => {
  for (const d of deliveries) {
    const response = await deliver(d);
    expect({ file: d.file, status: response.status }).toEqual({ file: d.file, status: 200 });
    expect(await response.json()).toEqual({ event: d.event, written: true });
  }

  expect(await rows('SELECT number, state, phase FROM mc.issues ORDER BY number')).toEqual([
    { number: 10, state: 'open', phase: 'Webhook Function handler' },
    { number: 44, state: 'open', phase: null },
    { number: 45, state: 'open', phase: null },
  ]);
  expect(
    await rows(`SELECT label FROM mc.issue_labels WHERE issue_number = 10 ORDER BY label`),
  ).toEqual([{ label: 'feature' }, { label: 'needs-owner' }]);
  expect(
    await rows('SELECT depends_on FROM mc.issue_dependencies WHERE issue_number = 10 ORDER BY 1'),
  ).toEqual([{ depends_on: 4 }, { depends_on: 6 }]);
  expect(
    await rows(`SELECT run_id, route, released_at FROM mc.claims WHERE issue_number = 10`),
  ).toEqual([
    { run_id: 'a1ba5462-3544-481a-92b4-25c62ad62d17', route: 'complex', released_at: null },
  ]);
  expect(await rows('SELECT pr_number, outcome, route, sha FROM mc.reviews')).toEqual([
    {
      pr_number: 34,
      outcome: 'merged',
      route: 'complex',
      sha: '9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1b0c',
    },
  ]);
  expect(await rows('SELECT pr_number, issue_number FROM mc.pull_request_issues')).toEqual([
    { pr_number: 34, issue_number: 10 },
  ]);
  expect(await rows('SELECT count(*)::int AS n FROM mc.metrics_lines')).toEqual([{ n: 1 }]);
  expect(
    await rows(`SELECT scenario_id, verdict, issue_number FROM mc.holdout_verdicts ORDER BY 1`),
  ).toEqual([
    { scenario_id: 'H-01', verdict: 'PASS', issue_number: null },
    { scenario_id: 'H-02', verdict: 'FAIL', issue_number: 41 },
    { scenario_id: 'H-03', verdict: 'INCOMPLETE', issue_number: 42 },
  ]);
  expect(await rows('SELECT title, version FROM mc.decisions')).toEqual([
    { title: 'Holdouts live in the repository, behind a hook', version: 'abd85896' },
  ]);
});

test('a needs-owner label payload sets that label on the issue', async () => {
  await deliver(named('01-'));
  await deliver(named('02-'));
  expect(
    await rows('SELECT label FROM mc.issue_labels WHERE issue_number = 10 ORDER BY 1'),
  ).toEqual([{ label: 'enhancement' }, { label: 'needs-owner' }]);
});

test('an older delivery of an issue does not undo a newer one', async () => {
  await deliver(named('02-'));
  await deliver(named('01-'));
  expect(
    await rows('SELECT label FROM mc.issue_labels WHERE issue_number = 10 ORDER BY 1'),
  ).toEqual([{ label: 'enhancement' }, { label: 'needs-owner' }]);
});

test('an Owner decisions needed edit stores each question, and closes one that is gone', async () => {
  await deliver(named('03-'));
  expect(
    await rows(
      `SELECT question_number, question, options, recommendation, default_option, default_at,
        closed_at FROM mc.owner_questions`,
    ),
  ).toEqual([
    {
      question_number: 3,
      question: 'Should the lanes panel show finished laps for an hour?',
      options: [
        { key: 'A', text: 'yes, faded' },
        { key: 'B', text: 'no, only running laps' },
      ],
      recommendation: 'A, so a merge that just happened is still visible.',
      default_option: 'A',
      default_at: new Date('2026-10-27T14:00:00Z'),
      closed_at: null,
    },
  ]);

  const answered = JSON.parse(new TextDecoder().decode(bytes(named('03-').file)));
  answered.issue.body = 'Questions the loop needs the owner to decide.\n';
  answered.issue.updated_at = '2026-10-26T09:00:00Z';
  const body = new TextEncoder().encode(JSON.stringify(answered));
  expect((await post('issues', body, await sign(SECRET, body))).status).toBe(200);
  expect(await rows('SELECT question_number, closed_at FROM mc.owner_questions')).toEqual([
    { question_number: 3, closed_at: new Date('2026-10-26T09:00:00Z') },
  ]);
});

test('a push with the appendix pin and verdict stores pin abd85896 and verdict helped', async () => {
  await deliver(named('09-'));
  const [pin] = await rows('SELECT archon_sha, hypothesis, measure FROM mc.pins');
  expect(pin?.archon_sha).toBe('abd85896');
  expect(String(pin?.hypothesis)).toStartWith('complex laps finish faster and are sent back less');
  expect(String(pin?.measure)).toStartWith('on the mission-control factory, complex-route');
  expect(await rows('SELECT pin, verdict, sentence FROM mc.verdicts')).toEqual([
    {
      pin: 'abd85896',
      verdict: 'helped',
      sentence: 'complex laps took 1.4 lap-hours per merge against 2.6, over 12 laps.',
    },
  ]);
  expect(requests).toEqual([
    {
      method: 'GET',
      url: 'https://api.github.com/repos/coleam00/ai-software-factory/contents/DECISIONS.md?ref=85d479ad987dd63e441622ecb03db65233e8a803',
    },
  ]);
});

test('every request the handler sends to GitHub is a GET', async () => {
  for (const d of deliveries) await deliver(d);
  for (const d of deliveries) await deliver(d);
  expect(requests.length).toBeGreaterThan(0);
  expect(requests.filter((r) => r.method !== 'GET')).toEqual([]);
});

test.each([
  ['a wrong signature', 'sha256=0000000000000000000000000000000000000000000000000000000000000000'],
  ['a signature under another secret', null],
  ['no signature', undefined],
])('%s returns 401 and changes no row', async (_, signature) => {
  await deliver(named('01-'));
  const before = await snapshot();
  for (const d of deliveries) {
    const body = bytes(d.file);
    const header = signature === null ? await sign('not-test', body) : (signature ?? null);
    const response = await post(d.event, body, header);
    expect({ file: d.file, status: response.status }).toEqual({ file: d.file, status: 401 });
  }
  expect(await snapshot()).toEqual(before);
  expect(requests).toEqual([]);
});

test('posting every payload twice leaves the rows as after the first post', async () => {
  for (const d of deliveries) await deliver(d);
  const first = await snapshot();
  for (const d of deliveries) expect((await deliver(d)).status).toBe(200);
  expect(await snapshot()).toEqual(first);
});

test('a delivery from a repository the dashboard does not follow writes nothing', async () => {
  const payload = JSON.parse(new TextDecoder().decode(bytes(named('01-').file)));
  payload.repository.full_name = 'someone/else';
  const body = new TextEncoder().encode(JSON.stringify(payload));
  const before = await snapshot();
  const response = await post('issues', body, await sign(SECRET, body));
  expect(await response.json()).toEqual({ event: 'issues', written: false });
  expect(await snapshot()).toEqual(before);
});
