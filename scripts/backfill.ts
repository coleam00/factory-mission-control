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
  type Commit,
  DECISIONS_PATH,
  deleteComment,
  type Factory,
  type Issue,
  type PullRequest,
  removeIssue,
  replaceDecisions,
  VERSIONS_REPOSITORY,
  writeComment,
  writeCommits,
  writeIssue,
  writePullRequest,
} from '../function/ingest';
import { failing, guardedDatabaseUrl, type Main, runCli } from './lib/cli';
import type { Tx } from './lib/db';

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
  commits: Pick<Commit, 'id' | 'message' | 'timestamp'>[];
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
  return {
    factories: read,
    commits: commits.map(({ sha, commit }) => ({
      id: sha,
      message: commit.message,
      timestamp: commit.committer.date,
    })),
    decisions,
  };
}

export interface Removed {
  issues: number;
  comments: number;
}

/**
 * Writes `history` with the webhook's upserts. With `readAt`, the time reading `history` began,
 * also removes each issue and comment of a factory created before then that `history` no longer
 * holds, closing the removed issues' open owner questions at that time. Rows created later came
 * from the webhook while GitHub was being read and stay.
 */
export async function storeHistory(tx: Tx, history: History, readAt?: string): Promise<Removed> {
  const removed: Removed = { issues: 0, comments: 0 };
  for (const { factory, issues, comments, pullRequests } of history.factories) {
    for (const issue of issues) await writeIssue(tx, factory, issue);
    for (const { issue, comment } of comments) await writeComment(tx, factory, issue, comment);
    for (const pr of pullRequests) await writePullRequest(tx, factory, pr);
    if (readAt === undefined) continue;

    const goneIssues = await tx.query(
      `SELECT number FROM mc.issues WHERE factory = $1 AND created_at < $3
        AND number NOT IN (SELECT v::integer FROM jsonb_array_elements_text($2::jsonb) v)`,
      [factory, issues.map((issue) => issue.number), readAt],
    );
    for (const { number } of goneIssues) await removeIssue(tx, factory, Number(number), readAt);
    const goneComments = await tx.query(
      `SELECT id FROM mc.comments WHERE factory = $1 AND created_at < $3
        AND id NOT IN (SELECT v::bigint FROM jsonb_array_elements_text($2::jsonb) v)`,
      [factory, comments.map(({ comment }) => comment.id), readAt],
    );
    for (const { id } of goneComments) await deleteComment(tx, factory, Number(id));
    removed.issues += goneIssues.length;
    removed.comments += goneComments.length;
  }
  await writeCommits(tx, history.commits);
  await replaceDecisions(tx, history.decisions);
  return removed;
}

/** The rows the dashboard now holds for each factory and for the versions repository. */
async function storedCounts(tx: Tx, history: History): Promise<string[]> {
  const count = async (sql: string, params: unknown[] = []) =>
    Number((await tx.query(`SELECT count(*)::int AS n FROM ${sql}`, params))[0]?.n);
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
    const db = deps.openDb(url);
    try {
      const lines: string[] = [];
      await db.transaction(async (tx) => {
        const removed = await storeHistory(tx, history, values.reconcile ? readAt : undefined);
        if (values.reconcile) {
          lines.push(`removed ${removed.issues} issue(s) and ${removed.comments} comment(s)`);
        }
        lines.push(...(await storedCounts(tx, history)));
      });
      for (const line of lines) deps.out(line);
    } finally {
      await db.close();
    }
  });
};

if (import.meta.main) await runCli(main);
