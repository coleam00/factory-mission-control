import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { archonDb, snapshot as snapshotOf } from '../db/test-db';
import factories from '../factories.json';
import type { Db, Row } from '../scripts/lib/db';
import { migrationsDir, readMigrationFiles, runMigrations } from '../scripts/migrate';
import { createWebhookApp } from './app';
import { createGitHub, type GetFetch } from './github';
import {
  METRICS_TITLE,
  OWNER_DECISIONS_TITLE,
  PACK_PATH,
  pinnedArchonSha,
  replaceDecisions,
  writeIssue,
} from './ingest';
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

/** The full sha the appendix pin's pack file pins; its subject names `abd85896`. */
const PINNED = 'abd85896e7971c9ac5199ed7e87973f27130250f';
const PACK_URL = `https://api.github.com/repos/coleam00/ai-software-factory/contents/${PACK_PATH}?ref=85d479ad987dd63e441622ecb03db65233e8a803`;
const DECISIONS_URL =
  'https://api.github.com/repos/coleam00/ai-software-factory/contents/DECISIONS.md?ref=main';
const pack = (sha: string) => JSON.stringify({ integration_revision_required: sha });

/** GitHub answering a pin's pack file read with `pinned` and any `DECISIONS.md` read with `decisions`. */
const answering =
  ({
    pinned = () => new Response(pack(PINNED)),
    decisions = () => new Response(DECISIONS),
  }: {
    pinned?: () => Response;
    decisions?: () => Response;
  }) =>
  (url: string) =>
    url.includes(`/contents/${PACK_PATH}?`) ? pinned() : decisions();

type Request = { url: string; method: string };

let db: Db;
let requests: Request[];
let respond: (url: string) => Response;
let app: ReturnType<typeof createWebhookApp>;

beforeEach(async () => {
  db = await archonDb();
  await runMigrations({ files: readMigrationFiles(migrationsDir(repoRoot)), db });
  requests = [];
  respond = answering({});
  const fetch: GetFetch = async (url, init) => {
    requests.push({ url, method: init.method });
    return respond(url);
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
  commits: { id: string; message: string; added: string[]; removed: string[] }[];
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

const labelTimes = () =>
  rows('SELECT label, labeled_at FROM mc.issue_labels WHERE issue_number = 10 ORDER BY 1');
const LABELLED = new Date('2026-10-25T05:10:02Z');

test('a needs-owner label payload sets that label on the issue, labelled when it was delivered', async () => {
  await deliver(named('01-'));
  await deliver(named('02-'));
  expect(await labelTimes()).toEqual([
    { label: 'enhancement', labeled_at: null },
    { label: 'needs-owner', labeled_at: LABELLED },
  ]);
});

test('a comment after the label leaves its time, and a label delivered after the comment still sets it', async () => {
  await deliver(named('02-'));
  await deliver(named('05-'));
  const inOrder = await labelTimes();
  await db.query('DELETE FROM mc.issue_labels');
  await deliver(named('05-'));
  await deliver(named('02-'));
  expect(await labelTimes()).toEqual(inOrder);
  expect(inOrder).toContainEqual({ label: 'needs-owner', labeled_at: LABELLED });
});

test('a label removed and added again is labelled at the second time', async () => {
  await deliver(named('02-'));
  await deliverChanged('02-', (p) => {
    p.action = 'unlabeled';
    p.issue.labels = [{ name: 'enhancement' }];
    p.issue.updated_at = '2026-10-26T08:00:00Z';
  });
  await deliverChanged('02-', (p) => {
    p.issue.updated_at = '2026-10-26T09:00:00Z';
  });
  // The first labelling, delivered again late, does not take the label back to its time.
  await deliver(named('02-'));
  expect(await labelTimes()).toContainEqual({
    label: 'needs-owner',
    labeled_at: new Date('2026-10-26T09:00:00Z'),
  });
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

test('a push with the appendix pin and verdict stores the full sha pin abd85896 pins and verdict helped', async () => {
  await deliver(named('09-'));
  const [pin] = await rows('SELECT archon_sha, hypothesis, measure FROM mc.pins');
  expect(pin?.archon_sha).toBe(PINNED);
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
    { method: 'GET', url: PACK_URL },
    { method: 'GET', url: DECISIONS_URL },
  ]);
});

test('a push of a pin with no reason stores the pin, its reason not recorded', async () => {
  await deliverChanged('09-', (p) => {
    for (const commit of p.commits) {
      if (commit.message.startsWith('Pin Archon ')) commit.message = 'Pin Archon abd85896';
    }
  });
  expect(await rows('SELECT sha, archon_sha, reason, hypothesis, measure FROM mc.pins')).toEqual([
    {
      sha: '85d479ad987dd63e441622ecb03db65233e8a803',
      archon_sha: PINNED,
      reason: null,
      hypothesis: null,
      measure: null,
    },
  ]);
});

test.each([
  ['the full sha a short subject names', 'abd85896', pack(PINNED), { sha: PINNED }],
  ['the full sha a full subject names', PINNED, pack(PINNED), { sha: PINNED }],
  ['no file', 'abd85896', null, { unresolved: `${PACK_PATH} missing` }],
  ['text that is not JSON', 'abd85896', 'not json', { unresolved: `${PACK_PATH} is not JSON` }],
  ['a short sha', 'abd85896', pack('abd85896'), { unresolved: `${PACK_PATH} pins no full sha` }],
  ['no pin', 'abd85896', '{}', { unresolved: `${PACK_PATH} pins no full sha` }],
  [
    'another version',
    'abd85896',
    pack('f'.repeat(40)),
    { unresolved: `pins ${'f'.repeat(40)}, not abd85896` },
  ],
])('a pin whose pack file holds %s resolves only to that full sha', (_, named, text, expected) => {
  expect(pinnedArchonSha(named, text)).toEqual(expected);
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
  respond = answering({ decisions: () => new Response(`# Decisions\n\n${entry('Old')}`) });
  await deliver(named('09-'));
  respond = answering({ decisions: () => new Response(`# Decisions\n\n${entry('New')}`) });
  await deliverChanged('09-', (p) => {
    p.commits[0].id = 'b'.repeat(40);
  });
  expect(await decisionsTitles()).toEqual([{ title: 'New' }]);

  expect((await deliver(named('09-'))).status).toBe(200);
  expect(await decisionsTitles()).toEqual([{ title: 'New' }]);
  const decisionsReads = requests.filter((r) => r.url.includes('/DECISIONS.md?'));
  expect(new Set(decisionsReads.map((r) => r.url.split('?')[1]))).toEqual(new Set(['ref=main']));
});

test('a DECISIONS.md the push did not remove but GitHub cannot find fails and keeps the rows', async () => {
  await deliver(named('09-'));
  const before = await snapshot();
  respond = answering({ decisions: () => new Response('Not Found', { status: 404 }) });
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

    respond = answering({ decisions: failure });
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

const pinRows = () =>
  rows('SELECT sha, archon_sha, reason, hypothesis, measure, committed_at FROM mc.pins');

test.each([
  ['403', () => new Response('rate limit exceeded', { status: 403 }), '403'],
  [
    'a 404, the file missing at that commit',
    () => new Response('Not Found', { status: 404 }),
    `85d479ad: ${PACK_PATH} missing`,
  ],
  ['500', () => new Response('Internal Server Error', { status: 500 }), '500'],
  [
    'a network error',
    (): Response => {
      throw new TypeError('fetch failed');
    },
    'network error (fetch failed)',
  ],
])(
  'a pack file read answered by %s keeps a stored pin, writes a first pin without a sha, and a later read fills it',
  async (_, failure, status) => {
    await deliver(named('09-'));
    const [resolved] = await pinRows();
    expect(resolved).toMatchObject({
      sha: '85d479ad987dd63e441622ecb03db65233e8a803',
      archon_sha: PINNED,
      reason: expect.stringMatching(/^holdouts fenced in the repository/),
      hypothesis: expect.stringMatching(/^complex laps finish faster/),
      measure: expect.stringMatching(/^on the mission-control factory/),
    });
    await db.query('DELETE FROM mc.verdicts');

    respond = answering({ pinned: failure });
    const unreadDelivery = async () => {
      const warn = spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const response = await deliver(named('09-'));
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
          event: 'push',
          written: true,
          pins: `unread: ${status}`,
        });
        expect(warn.mock.calls.map((args) => args.join(' '))).toEqual([
          expect.stringContaining(
            `${PACK_PATH} unread for pins: ${status}; pins written without an Archon sha`,
          ),
        ]);
      } finally {
        warn.mockRestore();
      }
      expect(await rows('SELECT verdict FROM mc.verdicts')).toEqual([{ verdict: 'helped' }]);
    };

    await unreadDelivery();
    expect(await pinRows()).toEqual([resolved]);

    await db.query('DELETE FROM mc.pins');
    await db.query('DELETE FROM mc.verdicts');
    await unreadDelivery();
    expect(await pinRows()).toEqual([{ ...resolved, archon_sha: null }]);

    respond = answering({});
    expect(await (await deliver(named('09-'))).json()).toEqual({ event: 'push', written: true });
    expect(await pinRows()).toEqual([resolved]);
  },
);

test('a pin whose pack file pins another version is written without a sha and says which', async () => {
  const other = 'f'.repeat(40);
  respond = answering({ pinned: () => new Response(pack(other)) });
  const warn = spyOn(console, 'warn').mockImplementation(() => {});
  try {
    expect(await (await deliver(named('09-'))).json()).toEqual({
      event: 'push',
      written: true,
      pins: `unread: 85d479ad: pins ${other}, not abd85896`,
    });
  } finally {
    warn.mockRestore();
  }
  expect(await pinRows()).toMatchObject([
    { sha: '85d479ad987dd63e441622ecb03db65233e8a803', archon_sha: null },
  ]);
  expect(await rows('SELECT verdict FROM mc.verdicts')).toEqual([{ verdict: 'helped' }]);
});

test('a push that removes DECISIONS.md empties the decisions', async () => {
  await deliver(named('09-'));
  respond = answering({ decisions: () => new Response('Not Found', { status: 404 }) });
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

const terminated = 'terminating connection due to administrator command';
test.each([
  [
    'a constraint violation is not retried',
    () =>
      Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' }),
    1,
  ],
  [
    'a Bun SQL connection that closes again is retried once',
    () => Object.assign(new Error('closed'), { code: 'ERR_POSTGRES_CONNECTION_CLOSED' }),
    2,
  ],
  [
    'a Bun SQL socket that closes while a reply is expected is retried once',
    () =>
      Object.assign(new Error('Failed to read data'), { code: 'ERR_POSTGRES_EXPECTED_REQUEST' }),
    2,
  ],
  [
    'a reset socket is retried once',
    () => Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
    2,
  ],
  [
    'a Bun SQL connection the server terminates again is retried once',
    () =>
      Object.assign(new Error(terminated), { code: 'ERR_POSTGRES_SERVER_ERROR', errno: '57P01' }),
    2,
  ],
  [
    'a pg.Pool connection the server terminates again is retried once',
    () => Object.assign(new Error(terminated), { code: '57P01' }),
    2,
  ],
  [
    'a node-postgres connection that ends again is retried once',
    () => new Error('Connection terminated unexpectedly'),
    2,
  ],
])('%s', async (_, failure, attempts) => {
  let transactions = 0;
  let drops = 0;
  app = createWebhookApp({
    secret: SECRET,
    db: {
      query: (sql, params) => db.query(sql, params),
      close: () => db.close(),
      transaction: async () => {
        transactions += 1;
        throw failure();
      },
      dropIdleConnections: async () => {
        drops += 1;
      },
    },
    factories: factories.factories,
    github: createGitHub(async (url) => respond(url)),
  });
  const warn = spyOn(console, 'warn').mockImplementation(() => {});
  const error = spyOn(console, 'error').mockImplementation(() => {});
  try {
    expect((await deliver(named('03-'))).status).toBe(500);
  } finally {
    warn.mockRestore();
    error.mockRestore();
  }
  expect(transactions).toBe(attempts);
  expect(drops).toBe(attempts - 1);
});

test.each([
  [
    'Bun SQL',
    () =>
      Object.assign(new Error(terminated), { code: 'ERR_POSTGRES_SERVER_ERROR', errno: '57P01' }),
  ],
  ['pg.Pool', () => Object.assign(new Error(terminated), { code: '57P01' })],
])(
  'a %s connection the server terminated is retried once and recorded once',
  async (_, failure) => {
    let transactions = 0;
    app = createWebhookApp({
      secret: SECRET,
      db: {
        query: (sql, params) => db.query(sql, params),
        close: () => db.close(),
        transaction: (fn) => {
          transactions += 1;
          return transactions === 1 ? Promise.reject(failure()) : db.transaction(fn);
        },
      },
      factories: factories.factories,
      github: createGitHub(async (url) => respond(url)),
    });
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect((await deliver(named('03-'))).status).toBe(200);
      expect(warn.mock.calls.map((args) => args.join(' '))).toEqual([
        expect.stringContaining(`connection closed before the first statement (${terminated})`),
      ]);
    } finally {
      warn.mockRestore();
    }
    expect(transactions).toBe(2);
    expect(await rows('SELECT number FROM mc.issues')).toEqual([{ number: 44 }]);
  },
);

test('a Loop metrics body is written in a few statements, a later line for the same time winning', async () => {
  const pass = (at: string, merged: number) =>
    `${at} | merged since last pass: ${merged} (simple ${merged}, complex 0, continue 0) | open PRs: 2 | ` +
    'loop send-backs since last pass: 1 | merge-gate refusals: 0 | ship correction rounds: 2 | ' +
    'needs-owner open: 1 | owner questions open: 2 | default branch checks: green (CI) | ' +
    'laps since last pass: 9 (empty 2, failed 0) | health actions: 1';
  const lines = [
    'One line per manager pass.',
    ...Array.from({ length: 60 }, (_, i) =>
      pass(`2026-10-${10 + Math.floor(i / 24)}T${String(i % 24).padStart(2, '0')}:00Z`, i),
    ),
    // The same time written again, with seconds: the later line wins, as upserting in turn did.
    pass('2026-10-10T00:00:00Z', 99),
    '2026-10-25T14:20Z | holdouts at 3e4f5a6b: H-01 PASS, H-02 FAIL #41, H-03 INCOMPLETE #42',
    // The same report again: its verdicts become this line's, H-03 gone, H-01 its later verdict.
    '2026-10-25T14:20Z | holdouts at 3e4f5a6c: H-01 FAIL #43, H-02 FAIL #41, H-01 PASS',
    '2026-10-26T09:00Z | holdouts at 3e4f5a6d: H-04 PASS',
  ];
  const statements: string[] = [];
  await db.transaction((tx) =>
    writeIssue(
      {
        query: (text, params) => {
          statements.push(text);
          return tx.query(text, params);
        },
      },
      'mission-control',
      {
        number: 777,
        title: 'Loop metrics',
        state: 'open',
        body: lines.join('\n'),
        html_url: 'https://github.com/o/r/issues/777',
        created_at: '2026-10-01T00:00:00Z',
        updated_at: '2026-10-26T09:00:00Z',
        closed_at: null,
        labels: [],
      } as unknown as Parameters<typeof writeIssue>[2],
    ),
  );
  const writes = (table: string) =>
    statements.filter((s) => s.replace(/\s+/g, ' ').includes(`INSERT INTO ${table} (`)).length;
  expect(writes('mc.metrics_lines')).toBe(1);
  expect(writes('mc.holdout_reports')).toBe(1);
  expect(writes('mc.holdout_verdicts')).toBe(1);
  expect(
    await rows('SELECT count(*)::int AS n FROM mc.metrics_lines WHERE issue_number = 777'),
  ).toEqual([{ n: 60 }]);
  expect(
    await rows(
      `SELECT merged_total FROM mc.metrics_lines WHERE issue_number = 777 AND at = '2026-10-10T00:00Z'`,
    ),
  ).toEqual([{ merged_total: 99 }]);
  expect(
    await rows(
      `SELECT r.sha, v.scenario_id, v.verdict, v.issue_number FROM mc.holdout_reports r
         JOIN mc.holdout_verdicts v ON v.report_id = r.id WHERE r.issue_number = 777
         ORDER BY r.at, v.scenario_id`,
    ),
  ).toEqual([
    { sha: '3e4f5a6c', scenario_id: 'H-01', verdict: 'PASS', issue_number: null },
    { sha: '3e4f5a6c', scenario_id: 'H-02', verdict: 'FAIL', issue_number: 41 },
    { sha: '3e4f5a6d', scenario_id: 'H-04', verdict: 'PASS', issue_number: null },
  ]);
});
