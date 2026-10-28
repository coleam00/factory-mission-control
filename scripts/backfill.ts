// `bun run backfill` and `bun run reconcile` (PRD 11.1, 11.2): every issue, comment, label and pull
// request of each factory in factories.json, and the pin and verdict commits and DECISIONS.md of the
// versions repository, read with GETs and stored through the webhook's own upserts. `reconcile`
// also removes the issues and comments GitHub no longer has. Both write the check branch in
// .mc-check.env; their `:main` forms write `main`, which only the owner runs.

import { parseArgs } from 'node:util';
import factories from '../factories.json';
import type { GitHub } from '../function/github';
import {
  type Comment,
  DECISIONS_PATH,
  deleteComment,
  type Factory,
  type Issue,
  type PullRequest,
  removeIssue,
  replaceDecisions,
  resolvePins,
  VERSIONS_REPOSITORY,
  type VersionCommit,
  writeComment,
  writeCommits,
  writeIssue,
  writePullRequest,
} from '../function/ingest';
import { failing, guardedDatabaseUrl, type Main, runCli } from './lib/cli';
import type { Db, Tx } from './lib/db';

interface FactoryHistory {
  factory: string;
  /** Issues only: GitHub's issue list also holds every pull request, which `pullRequests` has. */
  issues: Issue[];
  /** Each comment with the issue or pull request it is on. */
  comments: { issue: Issue; comment: Comment }[];
  pullRequests: PullRequest[];
}

export interface History {
  factories: FactoryHistory[];
  commits: VersionCommit[];
  /** Each pin written without an Archon sha because its full sha did not resolve, and why. */
  unresolvedPins: string[];
  decisions: string;
}

interface ListedComment extends Comment {
  issue_url: string;
}

interface ListedCommit {
  sha: string;
  commit: { message: string; committer: { date: string } };
}

export async function readHistory(github: GitHub, followed: Factory[]): Promise<History> {
  const read: FactoryHistory[] = [];
  for (const { name, repository } of followed) {
    const listed = await github.list<Issue>(`/repos/${repository}/issues?state=all&per_page=100`);
    const byNumber = new Map(listed.map((issue) => [issue.number, issue]));
    const comments = await github.list<ListedComment>(
      `/repos/${repository}/issues/comments?per_page=100`,
    );
    read.push({
      factory: name,
      issues: listed.filter((issue) => !issue.pull_request),
      comments: comments.flatMap((comment) => {
        const issue = byNumber.get(Number(comment.issue_url.split('/').pop()));
        return issue ? [{ issue, comment }] : [];
      }),
      pullRequests: await github.list<PullRequest>(
        `/repos/${repository}/pulls?state=all&per_page=100`,
      ),
    });
  }

  const { default_branch: branch } = await github.get<{ default_branch: string }>(
    `/repos/${VERSIONS_REPOSITORY}`,
  );
  const commits = await github.list<ListedCommit>(
    `/repos/${VERSIONS_REPOSITORY}/commits?sha=${encodeURIComponent(branch)}&per_page=100`,
  );
  // Stored decisions are replaced wholesale, so a missing file must not read as an empty log.
  const decisions = await github.fileAt(VERSIONS_REPOSITORY, DECISIONS_PATH, branch);
  if (decisions === null) {
    throw new Error(
      `${VERSIONS_REPOSITORY} has no ${DECISIONS_PATH} on ${branch}; nothing written`,
    );
  }
  const pins = await resolvePins(
    github,
    commits.map(({ sha, commit }) => ({
      id: sha,
      message: commit.message,
      timestamp: commit.committer.date,
    })),
  );
  return { factories: read, commits: pins.commits, unresolvedPins: pins.unresolved, decisions };
}

export interface Removed {
  issues: number;
  comments: number;
}

/**
 * How many items one transaction writes at most, and how long it may stay open before it commits
 * after the item it is on. Each batch commits on its own, so a run never holds the dashboard's
 * rows locked, or Realtime's starting snapshot back, for longer than about one batch (#260): from
 * the owner's machine each statement is a ~250 ms round trip to Neon, so a count alone let one
 * transaction of 25 issues stay open 28 s. Every write is an idempotent upsert or removal, so a run
 * that stops part way leaves rows the next run completes.
 */
export const BATCH = 25;
export const BATCH_MS = 2000;

/**
 * Runs `write` over `items`, in order, in short transactions: each commits after BATCH items or
 * once it has been open BATCH_MS, whichever comes first, and always writes at least one item.
 */
export async function inBatches<T>(
  db: Db,
  items: readonly T[],
  write: (tx: Tx, item: T) => Promise<void>,
  limits: { count: number; ms: number } = { count: BATCH, ms: BATCH_MS },
): Promise<void> {
  let next = 0;
  while (next < items.length) {
    await db.transaction(async (tx) => {
      const opened = performance.now();
      for (let n = 0; next < items.length && n < limits.count; n++) {
        if (n > 0 && performance.now() - opened >= limits.ms) break;
        await write(tx, items[next] as T);
        next++;
      }
    });
  }
}

/**
 * Writes `history` with the webhook's upserts, in short transactions (see BATCH and BATCH_MS), after
 * every GitHub read is done: no transaction is open across a network call. With `readAt`, the time
 * reading `history` began, also removes each issue and comment of a factory created before then
 * that `history` no longer holds, closing the removed issues' open owner questions at that time.
 * Rows created later came from the webhook while GitHub was being read and stay.
 */
export async function storeHistory(db: Db, history: History, readAt?: string): Promise<Removed> {
  const removed: Removed = { issues: 0, comments: 0 };
  for (const { factory, issues, comments, pullRequests } of history.factories) {
    await inBatches(db, issues, (tx, issue) => writeIssue(tx, factory, issue));
    await inBatches(db, comments, (tx, { issue, comment }) =>
      writeComment(tx, factory, issue, comment),
    );
    await inBatches(db, pullRequests, (tx, pr) => writePullRequest(tx, factory, pr));
    if (readAt === undefined) continue;

    // Read outside a transaction; each removal re-checks nothing, it is an idempotent delete.
    const goneIssues = await db.query(
      `SELECT number FROM mc.issues WHERE factory = $1 AND created_at < $3
        AND number NOT IN (SELECT v::integer FROM jsonb_array_elements_text($2::jsonb) v)`,
      [factory, issues.map((issue) => issue.number), readAt],
    );
    await inBatches(db, goneIssues, (tx, { number }) =>
      removeIssue(tx, factory, Number(number), readAt),
    );
    const goneComments = await db.query(
      `SELECT id FROM mc.comments WHERE factory = $1 AND created_at < $3
        AND id NOT IN (SELECT v::bigint FROM jsonb_array_elements_text($2::jsonb) v)`,
      [factory, comments.map(({ comment }) => comment.id), readAt],
    );
    await inBatches(db, goneComments, (tx, { id }) => deleteComment(tx, factory, Number(id)));
    removed.issues += goneIssues.length;
    removed.comments += goneComments.length;
  }
  await inBatches(db, history.commits, (tx, commit) => writeCommits(tx, [commit]));
  // DECISIONS.md replaces the stored decisions wholesale, so it stays one transaction: one file.
  await db.transaction((tx) => replaceDecisions(tx, history.decisions));
  return removed;
}

/** The rows the dashboard now holds for each factory and for the versions repository. */
async function storedCounts(db: Tx, history: History): Promise<string[]> {
  const count = async (sql: string, params: unknown[] = []) =>
    Number((await db.query(`SELECT count(*)::int AS n FROM ${sql}`, params))[0]?.n);
  const lines: string[] = [];
  for (const { factory } of history.factories) {
    const of = (table: string) => count(`${table} WHERE factory = $1`, [factory]);
    lines.push(
      `${factory}: ${await of('mc.issues')} issues, ${await of('mc.comments')} comments, ` +
        `${await of('mc.issue_labels')} labels, ${await of('mc.pull_requests')} pull requests`,
    );
  }
  lines.push(
    `${VERSIONS_REPOSITORY}: ${await count('mc.pins')} pins, ${await count('mc.verdicts')} verdicts, ` +
      `${await count('mc.decisions')} decisions`,
  );
  return lines;
}

const USAGE =
  'usage: bun run backfill | bun run reconcile (the check branch in .mc-check.env) | ' +
  'bun run backfill:main | bun run reconcile:main (main, the owner only)';

export const main: Main = async (argv, deps) => {
  let values: { reconcile?: boolean; main?: boolean; help?: boolean };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        reconcile: { type: 'boolean' },
        main: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    }));
  } catch (error) {
    deps.err(error instanceof Error ? `${error.message}\n${USAGE}` : USAGE);
    return 2;
  }
  if (values.help) {
    deps.out(USAGE);
    return 0;
  }
  return failing(deps, async () => {
    // No terminal prompt for `:main`, unlike `migrate:main`: the owner schedules the nightly run.
    const url = await guardedDatabaseUrl(deps, values.main ? 'main' : 'check');
    const readAt = deps.now().toISOString();
    const history = await readHistory(deps.github(), factories.factories);
    // Every GitHub read is done before the first write, and each write is its own short
    // transaction: nothing holds the dashboard's rows while GitHub answers (#260).
    const db = deps.openDb(url);
    try {
      const lines: string[] = [];
      const removed = await storeHistory(db, history, values.reconcile ? readAt : undefined);
      if (values.reconcile) {
        lines.push(`removed ${removed.issues} issue(s) and ${removed.comments} comment(s)`);
      }
      lines.push(...(await storedCounts(db, history)));
      lines.push(...history.unresolvedPins.map((pin) => `pin without an Archon sha ${pin}`));
      for (const line of lines) deps.out(line);
    } finally {
      await db.close();
    }
  });
};

if (import.meta.main) await runCli(main);
