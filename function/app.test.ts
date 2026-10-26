import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { archonDb, snapshot as snapshotOf } from '../db/test-db';
import factories from '../factories.json';
import type { Db, Row } from '../scripts/lib/db';
import { migrationsDir, readMigrationFiles, runMigrations } from '../scripts/migrate';
import { createWebhookApp } from './app';
import { createGitHub, type GetFetch } from './github';
import { METRICS_TITLE, OWNER_DECISIONS_TITLE, replaceDecisions } from './ingest';
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
let respond: () => Response;
let app: ReturnType<typeof createWebhookApp>;

beforeEach(async () => {
  db = await archonDb();
  await runMigrations({ files: readMigrationFiles(migrationsDir(repoRoot)), db });
  requests = [];
  respond = () => new Response(DECISIONS);
  const fetch: GetFetch = async (url, init) => {
    requests.push({ url, method: init.method });
    return respond();
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

/** The fixture fields the tests below change, across every event's payload. */
interface FixturePayload {
  action: string;
  ref: string;
  deleted: boolean;
  repository: { full_name: string };
  commits: { id: string; added: string[]; removed: string[] }[];
  comment: { body: string; updated_at: string };
  issue: { body: string; labels: { name: string }[]; updated_at: string };
}

/** Delivers fixture `prefix` after `change` edits its payload, signed again with the secret. */
async function deliverChanged(
  prefix: string,
  change: (payload: FixturePayload) => void,
): Promise<Response> {
  const d = named(prefix);
  const payload = JSON.parse(new TextDecoder().decode(bytes(d.file)));
  change(payload);
  const body = new TextEncoder().encode(JSON.stringify(payload));
  return post(d.event, body, await sign(SECRET, body));
}

const snapshot = () => snapshotOf(db);
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

  const answered = await deliverChanged('03-', (p) => {
    p.issue.body = 'Questions the loop needs the owner to decide.\n';
    p.issue.updated_at = '2026-10-26T09:00:00Z';
  });
  expect(answered.status).toBe(200);
  expect(await rows('SELECT question_number, closed_at FROM mc.owner_questions')).toEqual([
    { question_number: 3, closed_at: new Date('2026-10-26T09:00:00Z') },
  ]);
});

test('a push with the appendix pin and verdict stores pin abd85896 and verdict helped', async () => {
  await deliver(named('09-'));
  const [pin] = await rows('SELECT archon_sha, hypothesis, measure, factory FROM mc.pins');
  expect(pin?.archon_sha).toBe('abd85896');
  expect(pin?.factory).toBe('mission-control');
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
      url: 'https://api.github.com/repos/coleam00/ai-software-factory/contents/DECISIONS.md?ref=main',
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
  const before = await snapshot();
  const response = await deliverChanged('01-', (p) => {
    p.repository.full_name = 'someone/else';
  });
  expect(await response.json()).toEqual({ event: 'issues', written: false });
  expect(await snapshot()).toEqual(before);
});

test('the ingest manager titles are the pack’s MANAGER_TITLES', async () => {
  // A computed path keeps tsc out of the pack, whose `.ts` import extensions this config refuses.
  const workable = join(repoRoot, 'fixtures', 'pack', 'sdlc', '.shared', 'workable.ts');
  const { MANAGER_TITLES } = await import(workable);
  expect(new Set([OWNER_DECISIONS_TITLE, METRICS_TITLE])).toEqual(MANAGER_TITLES);
});

test.each([
  ['a push to another branch', (p: FixturePayload) => (p.ref = 'refs/heads/feature')],
  ['a deleted branch', (p: FixturePayload) => (p.deleted = true)],
  [
    'a push to another repository',
    (p: FixturePayload) => (p.repository.full_name = 'coleam00/factory-mission-control'),
  ],
])('%s writes no pin, verdict or decision and reads nothing', async (_, change) => {
  const before = await snapshot();
  const response = await deliverChanged('09-', change);
  expect(await response.json()).toEqual({ event: 'push', written: false });
  expect(await snapshot()).toEqual(before);
  expect(requests).toEqual([]);
});

const decisionsTitles = () => rows('SELECT title FROM mc.decisions ORDER BY title');
const entry = (title: string) =>
  `## 2026-10-25 ${title}\nDecision: d.\nWhy: w.\nReplaces: r.\nVersion: abd85896\n`;

test('decisions follow DECISIONS.md on the default branch, even when an older push is redelivered', async () => {
  respond = () => new Response(`# Decisions\n\n${entry('Old')}`);
  await deliver(named('09-'));
  respond = () => new Response(`# Decisions\n\n${entry('New')}`);
  await deliverChanged('09-', (p) => {
    p.commits[0].id = 'b'.repeat(40);
  });
  expect(await decisionsTitles()).toEqual([{ title: 'New' }]);

  expect((await deliver(named('09-'))).status).toBe(200);
  expect(await decisionsTitles()).toEqual([{ title: 'New' }]);
  expect(new Set(requests.map((r) => r.url.split('?')[1]))).toEqual(new Set(['ref=main']));
});

test('a DECISIONS.md the push did not remove but GitHub cannot find fails and keeps the rows', async () => {
  await deliver(named('09-'));
  const before = await snapshot();
  respond = () => new Response('Not Found', { status: 404 });
  const error = spyOn(console, 'error').mockImplementation(() => {});
  try {
    expect((await deliver(named('09-'))).status).toBe(500);
    expect(error.mock.calls.map((args) => String(args[0]))).toEqual(['push delivery failed:']);
    expect(String(error.mock.calls[0]?.[1])).toContain(
      'DECISIONS.md is missing on main but this push did not remove it',
    );
  } finally {
    error.mockRestore();
  }
  expect(await snapshot()).toEqual(before);
});

test.each([
  ['403', () => new Response('rate limit exceeded', { status: 403 }), '403'],
  ['500', () => new Response('Internal Server Error', { status: 500 }), '500'],
  [
    'a network error',
    (): Response => {
      throw new TypeError('fetch failed');
    },
    'network error (fetch failed)',
  ],
])(
  'a DECISIONS.md read answered by %s records the push and keeps decisions',
  async (_, failure, status) => {
    await deliver(named('09-'));
    const succeeded = await snapshot();
    await db.query('DELETE FROM mc.pins');
    await db.query('DELETE FROM mc.verdicts');
    const kept = `# Decisions

${entry('Kept')}`;
    await db.transaction((tx) => replaceDecisions(tx, kept));
    const before = await snapshot();

    respond = failure;
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const response = await deliver(named('09-'));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        event: 'push',
        written: true,
        decisions: `unread: ${status}`,
      });
      expect(warn.mock.calls.map((args) => args.join(' '))).toEqual([
        expect.stringContaining(`DECISIONS.md unread: ${status}`),
      ]);
    } finally {
      warn.mockRestore();
    }
    expect(await snapshot()).toEqual({
      ...before,
      pins: succeeded.pins ?? [],
      verdicts: succeeded.verdicts ?? [],
    });
    expect(await decisionsTitles()).toEqual([{ title: 'Kept' }]);
  },
);

test('a push that removes DECISIONS.md empties the decisions', async () => {
  await deliver(named('09-'));
  respond = () => new Response('Not Found', { status: 404 });
  const response = await deliverChanged('09-', (p) => {
    p.commits[0].added = [];
    p.commits[0].removed = ['DECISIONS.md'];
  });
  expect(response.status).toBe(200);
  expect(await decisionsTitles()).toEqual([]);
});

const commentRows = () =>
  rows('SELECT id FROM mc.comments ORDER BY id').then((r) => r.map((c) => Number(c.id)));
const reviewOutcomes = () => rows('SELECT outcome FROM mc.reviews');

test('a deleted review comment removes its comment and review rows', async () => {
  await deliver(named('06-'));
  expect(await reviewOutcomes()).toEqual([{ outcome: 'merged' }]);
  await deliverChanged('06-', (p) => (p.action = 'deleted'));
  expect(await commentRows()).toEqual([]);
  expect(await reviewOutcomes()).toEqual([]);
});

test('a review comment edited into plain text keeps the comment and drops the review', async () => {
  await deliver(named('06-'));
  await deliverChanged('06-', (p) => {
    p.action = 'edited';
    p.comment.body = 'hello';
    p.comment.updated_at = '2026-10-25T12:00:00Z';
  });
  expect(await commentRows()).toEqual([6394500001]);
  expect(await reviewOutcomes()).toEqual([]);
});

test('an older delivery of a comment does not undo a newer one', async () => {
  await deliverChanged('06-', (p) => {
    p.action = 'edited';
    p.comment.body = 'Loop review: sent back (route: complex)';
    p.comment.updated_at = '2026-10-25T12:00:00Z';
  });
  const before = await snapshot();
  await deliver(named('06-'));
  expect(await snapshot()).toEqual(before);
});

test.each(['deleted', 'transferred'])('an issue %s leaves the mirror', async (action) => {
  await deliver(named('03-'));
  await deliverChanged('03-', (p) => {
    p.action = 'labeled';
    p.issue.labels = [{ name: 'needs-owner' }];
    p.issue.body += '\nDepends on: #1\n';
    p.issue.updated_at = '2026-10-26T08:00:00Z';
  });
  expect(await rows('SELECT depends_on FROM mc.issue_dependencies')).toEqual([{ depends_on: 1 }]);
  await deliverChanged('03-', (p) => {
    p.action = action;
    p.issue.updated_at = '2026-10-26T09:00:00Z';
  });
  expect(await rows('SELECT number FROM mc.issues')).toEqual([]);
  expect(await rows('SELECT label FROM mc.issue_labels')).toEqual([]);
  expect(await rows('SELECT depends_on FROM mc.issue_dependencies')).toEqual([]);
  expect(await rows('SELECT question_number, closed_at FROM mc.owner_questions')).toEqual([
    { question_number: 3, closed_at: new Date('2026-10-26T09:00:00Z') },
  ]);
});
