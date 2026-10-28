// Turns one verified GitHub delivery into the rows it names (PRD 11.2, 11.5). Every write is an
// upsert or a set replacement keyed on GitHub's own ids, so redelivering a payload changes nothing,
// and every timestamp comes from the payload, never the clock.

import {
  parseClaim,
  parseClaimReleased,
  parseClosingIssues,
  parseDependsOn,
  parseOwnerQuestions,
  parsePhase,
  parseReview,
} from '../parsers/comments';
import { parsePin, parseVerdict } from '../parsers/commits';
import { parseDecisions } from '../parsers/decisions';
import {
  type HoldoutsLine,
  type MetricsLine,
  parseHoldoutsLine,
  parseMetricsLine,
} from '../parsers/metrics';
import type { Tx } from '../scripts/lib/db';
import { type GitHub, GitHubError } from './github';

/** Pins, verdicts and `DECISIONS.md` come from this repository's default branch only. */
export const VERSIONS_REPOSITORY = 'coleam00/ai-software-factory';
export const DECISIONS_PATH = 'DECISIONS.md';
/** A pin commit's own copy of the pack it pins, whose `integration_revision_required` is the full sha. */
export const PACK_PATH = 'template/factory/pack.json';

/** The manager's issues whose bodies the loop writes; a test holds them to the pack's `MANAGER_TITLES`. */
export const OWNER_DECISIONS_TITLE = 'Owner decisions needed';
export const METRICS_TITLE = 'Loop metrics';

export interface Factory {
  name: string;
  repository: string;
}

// The fields of GitHub's webhook payloads this module reads, which its REST API returns in the same
// shape. The signature vouches for the sender, so the payload is taken in GitHub's documented shape.
interface Repository {
  full_name: string;
  default_branch: string;
}

export interface Issue {
  number: number;
  title: string;
  state: 'open' | 'closed';
  body: string | null;
  html_url: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  labels: { name: string }[];
  pull_request?: unknown;
}

export interface Comment {
  id: number;
  body: string;
  user: { login: string };
  html_url: string;
  created_at: string;
  updated_at: string;
}

export interface PullRequest {
  number: number;
  title: string;
  state: 'open' | 'closed';
  body: string | null;
  merged_at: string | null;
  head: { sha: string };
  html_url: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

export interface Commit {
  id: string;
  message: string;
  timestamp: string;
  added: string[];
  modified: string[];
  removed: string[];
}

/** A commit of the versions repository; `archonSha` is set on a pin whose full sha was resolved. */
export type VersionCommit = Pick<Commit, 'id' | 'message' | 'timestamp'> & { archonSha?: string };

interface Payloads {
  issues: { action: string; issue: Issue; repository: Repository };
  issue_comment: { action: string; issue: Issue; comment: Comment; repository: Repository };
  label: {
    action: string;
    label: { name: string };
    changes?: { name?: { from: string } };
    repository: Repository;
  };
  pull_request: { action: string; pull_request: PullRequest; repository: Repository };
  push: {
    ref: string;
    deleted: boolean;
    commits: Commit[];
    repository: Repository;
  };
}

export type Write = (tx: Tx) => Promise<void>;

export interface Prepared {
  write: Write;
  /** Set when the push touched `DECISIONS.md` but GitHub would not give it: what GitHub said. */
  decisionsUnread?: string;
  /** Set when a pin of the push was written without its Archon sha: which, and why. */
  pinsUnread?: string;
}

export interface Context {
  factories: Factory[];
  github: GitHub;
}

/**
 * The write a delivery makes, or null when it names nothing the dashboard keeps. Any GitHub read
 * happens here, before the caller opens a transaction.
 */
export async function prepare(
  event: string,
  payload: unknown,
  { factories, github }: Context,
): Promise<Prepared | null> {
  const repository = (payload as { repository?: Repository }).repository;
  if (!repository) return null;

  if (event === 'push') {
    const push = payload as Payloads['push'];
    if (repository.full_name !== VERSIONS_REPOSITORY) return null;
    if (push.deleted || push.ref !== `refs/heads/${repository.default_branch}`) return null;
    const pins = await pinsAfter(push, github);
    const decisions = await decisionsAfter(push, repository.default_branch, github);
    const text = decisions?.text;
    return {
      write: async (tx) => {
        await writeCommits(tx, pins.commits);
        if (text !== undefined) await replaceDecisions(tx, text);
      },
      decisionsUnread: decisions?.unread,
      pinsUnread: pins.unread,
    };
  }

  const write = mirrorWrite(event, payload, repository, factories);
  return write ? { write } : null;
}

/** The write a delivery about a followed factory's issues, comments, labels or PRs makes. */
function mirrorWrite(
  event: string,
  payload: unknown,
  repository: Repository,
  factories: Factory[],
): Write | null {
  const factory = factories.find(
    (f) => f.repository.toLowerCase() === repository.full_name.toLowerCase(),
  )?.name;
  if (!factory) return null;

  switch (event) {
    case 'issues': {
      const { action, issue } = payload as Payloads['issues'];
      if (action === 'deleted' || action === 'transferred') {
        return (tx) => removeIssue(tx, factory, issue.number, issue.updated_at);
      }
      return (tx) => writeIssue(tx, factory, issue);
    }
    case 'issue_comment': {
      const { action, issue, comment } = payload as Payloads['issue_comment'];
      return async (tx) => {
        if (!issue.pull_request) await writeIssue(tx, factory, issue);
        if (action === 'deleted') await deleteComment(tx, factory, comment.id);
        else await writeComment(tx, factory, issue, comment);
      };
    }
    case 'label': {
      const { action, label, changes } = payload as Payloads['label'];
      const from = changes?.name?.from;
      if (action === 'deleted') return (tx) => deleteLabel(tx, factory, label.name);
      if (action === 'edited' && from) return (tx) => renameLabel(tx, factory, from, label.name);
      return null;
    }
    case 'pull_request': {
      const { pull_request } = payload as Payloads['pull_request'];
      return (tx) => writePullRequest(tx, factory, pull_request);
    }
    default:
      return null;
  }
}

/**
 * The push's commits with each pin's full Archon sha resolved. When GitHub refuses or cannot be
 * reached, the push's pins are written without a sha and the result says so; the next backfill
 * reads them again. A stored sha is never cleared or rewritten short.
 */
async function pinsAfter(
  push: Payloads['push'],
  github: GitHub,
): Promise<{ commits: VersionCommit[]; unread?: string }> {
  try {
    const { commits, unresolved } = await resolvePins(github, push.commits);
    return { commits, unread: unresolved.length ? unresolved.join('; ') : undefined };
  } catch (error) {
    return { commits: push.commits, unread: unreadBecause(error) };
  }
}

/** What a failed GitHub read says: the status GitHub answered, or the network error. */
function unreadBecause(error: unknown): string {
  if (error instanceof GitHubError) return String(error.status);
  return `network error (${error instanceof Error ? error.message : String(error)})`;
}

/**
 * The full Archon sha a pin commit pins: `integration_revision_required` in its `PACK_PATH`, when
 * that is a full sha extending the one the subject names. Anything else is unresolved, so a pin
 * never stores a short sha or a version its subject does not claim.
 */
export function pinnedArchonSha(
  named: string,
  pack: string | null,
): { sha: string; unresolved?: never } | { sha?: never; unresolved: string } {
  if (pack === null) return { unresolved: `${PACK_PATH} missing` };
  let value: unknown;
  try {
    value = (JSON.parse(pack) as { integration_revision_required?: unknown })
      ?.integration_revision_required;
  } catch {
    return { unresolved: `${PACK_PATH} is not JSON` };
  }
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/.test(value)) {
    return { unresolved: `${PACK_PATH} pins no full sha` };
  }
  if (!value.startsWith(named)) return { unresolved: `pins ${value}, not ${named}` };
  return { sha: value };
}

/**
 * `commits` with `archonSha` set on each pin whose `PACK_PATH` at that commit resolves, and why
 * each other pin did not. A commit that is not a pin costs no request; GitHub's errors propagate.
 */
export async function resolvePins(
  github: GitHub,
  commits: Pick<Commit, 'id' | 'message' | 'timestamp'>[],
): Promise<{ commits: VersionCommit[]; unresolved: string[] }> {
  const resolved: VersionCommit[] = [];
  const unresolved: string[] = [];
  for (const commit of commits) {
    const pin = parsePin(commit.message);
    if (!pin) {
      resolved.push(commit);
      continue;
    }
    const pack = await github.fileAt(VERSIONS_REPOSITORY, PACK_PATH, commit.id);
    const { sha, unresolved: reason } = pinnedArchonSha(pin.archonSha, pack);
    if (reason !== undefined) unresolved.push(`${commit.id.slice(0, 8)}: ${reason}`);
    resolved.push(sha === undefined ? commit : { ...commit, archonSha: sha });
  }
  return { commits: resolved, unresolved };
}

/**
 * `DECISIONS.md` as the default branch holds it now, when the push touched the file, else
 * undefined. Reading the branch rather than the pushed commit means a redelivered older push
 * cannot roll the table back to that push's file. When GitHub refuses or cannot be reached (a
 * rate limit's 403, a 5xx, a network error), the result says so and the stored decisions stay as
 * they were: the push's commits are still worth recording, and the next push or a reconcile reads
 * the file again. A missing file is only believed when this push removed it; any other 404 (a
 * private repository, a ref GitHub cannot resolve yet) throws, so the delivery fails visibly
 * instead of emptying the table.
 */
async function decisionsAfter(
  push: Payloads['push'],
  branch: string,
  github: GitHub,
): Promise<{ text: string; unread?: never } | { text?: never; unread: string } | undefined> {
  const touched = (commit: Commit) =>
    [...commit.added, ...commit.modified, ...commit.removed].includes(DECISIONS_PATH);
  const lastTouch = push.commits.findLast(touched);
  if (!lastTouch) return undefined;
  let text: string | null;
  try {
    text = await github.fileAt(VERSIONS_REPOSITORY, DECISIONS_PATH, branch);
  } catch (error) {
    return { unread: unreadBecause(error) };
  }
  if (text !== null) return { text };
  if (lastTouch.removed.includes(DECISIONS_PATH)) return { text: '' };
  throw new Error(`${DECISIONS_PATH} is missing on ${branch} but this push did not remove it`);
}

/**
 * Makes the rows of `table` under `key` hold exactly `values` in `column`, touching no row that
 * stays. `key` maps column to value; table and column names are this module's own constants.
 */
async function replaceSet(
  tx: Tx,
  table: string,
  key: Record<string, string | number>,
  column: string,
  type: 'text' | 'integer',
  values: (string | number)[],
): Promise<void> {
  const columns = Object.keys(key);
  const params = [...Object.values(key), values];
  const set = `$${params.length}::jsonb`;
  const where = columns.map((name, i) => `${name} = $${i + 1}`).join(' AND ');
  await tx.query(
    `DELETE FROM ${table} WHERE ${where}
      AND ${column} NOT IN (SELECT v::${type} FROM jsonb_array_elements_text(${set}) v)`,
    params,
  );
  await tx.query(
    `INSERT INTO ${table} (${columns.join(', ')}, ${column})
      SELECT ${columns.map((_, i) => `$${i + 1}`).join(', ')}, v::${type}
      FROM jsonb_array_elements_text(${set}) v
      ON CONFLICT DO NOTHING`,
    params,
  );
}

/**
 * Upserts the issue and every fact its body carries. A delivery older than the stored issue
 * (GitHub does not promise order) writes nothing.
 */
export async function writeIssue(tx: Tx, factory: string, issue: Issue): Promise<void> {
  const body = issue.body ?? '';
  const [current] = await tx.query(
    `INSERT INTO mc.issues (factory, number, title, state, phase, url, created_at, updated_at, closed_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (factory, number) DO UPDATE SET title = EXCLUDED.title, state = EXCLUDED.state,
        phase = EXCLUDED.phase, url = EXCLUDED.url, created_at = EXCLUDED.created_at,
        updated_at = EXCLUDED.updated_at, closed_at = EXCLUDED.closed_at
      WHERE mc.issues.updated_at <= EXCLUDED.updated_at
      RETURNING number`,
    [
      factory,
      issue.number,
      issue.title,
      issue.state,
      parsePhase(body),
      issue.html_url,
      issue.created_at,
      issue.updated_at,
      issue.closed_at,
    ],
  );
  if (!current) return;

  const key = { factory, issue_number: issue.number };
  const labels = issue.labels.map((label) => label.name);
  await replaceSet(tx, 'mc.issue_labels', key, 'label', 'text', labels);
  await replaceSet(tx, 'mc.issue_dependencies', key, 'depends_on', 'integer', parseDependsOn(body));
  const title = issue.title.trim();
  if (title === OWNER_DECISIONS_TITLE) await writeOwnerQuestions(tx, factory, issue);
  if (title === METRICS_TITLE) await writeMetrics(tx, factory, issue.number, body);
}

/**
 * An issue deleted or transferred out of the repository leaves the mirror; its open owner
 * questions close at `removedAt`. Nothing records the removal, so an older delivery about the
 * issue that arrives after this one brings it back.
 */
export async function removeIssue(
  tx: Tx,
  factory: string,
  number: number,
  removedAt: string,
): Promise<void> {
  const key = [factory, number];
  await tx.query('DELETE FROM mc.issues WHERE factory = $1 AND number = $2', key);
  await tx.query('DELETE FROM mc.issue_labels WHERE factory = $1 AND issue_number = $2', key);
  await tx.query('DELETE FROM mc.issue_dependencies WHERE factory = $1 AND issue_number = $2', key);
  await tx.query(
    `UPDATE mc.owner_questions SET closed_at = $3
      WHERE factory = $1 AND issue_number = $2 AND closed_at IS NULL`,
    [...key, removedAt],
  );
}

/** One row per question; a question gone from the body (answered or defaulted) is closed. */
async function writeOwnerQuestions(tx: Tx, factory: string, issue: Issue): Promise<void> {
  const open = issue.state === 'open' ? parseOwnerQuestions(issue.body ?? '') : [];
  for (const q of open) {
    await tx.query(
      `INSERT INTO mc.owner_questions (factory, issue_number, question_number, question, options,
          recommendation, default_option, default_at, raised_at)
        VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9)
        ON CONFLICT (factory, issue_number, question_number) DO UPDATE SET
          question = EXCLUDED.question, options = EXCLUDED.options,
          recommendation = EXCLUDED.recommendation, default_option = EXCLUDED.default_option,
          default_at = EXCLUDED.default_at, closed_at = NULL`,
      [
        factory,
        issue.number,
        q.number,
        q.question,
        q.options,
        q.recommendation,
        q.default,
        q.defaultAt,
        issue.updated_at,
      ],
    );
  }
  await tx.query(
    `UPDATE mc.owner_questions SET closed_at = $3
      WHERE factory = $1 AND issue_number = $2 AND closed_at IS NULL
        AND question_number NOT IN (SELECT v::integer FROM jsonb_array_elements_text($4::jsonb) v)`,
    [factory, issue.number, issue.updated_at, open.map((q) => q.number)],
  );
}

/**
 * Each manager pass line of the `Loop metrics` body; lines are only ever appended. Written in a
 * fixed handful of statements however long the body is (#260): one per line was a round trip
 * each, and a body of a few hundred lines held its transaction open ~25 s from the owner's
 * machine. A later line for the same `at` wins, as it did when each line was upserted in turn.
 */
async function writeMetrics(tx: Tx, factory: string, issue: number, body: string): Promise<void> {
  const metrics = new Map<number, MetricsLine>();
  const reports = new Map<number, HoldoutsLine>();
  for (const line of body.split(/\r?\n/)) {
    const pass = parseMetricsLine(line);
    if (pass) {
      metrics.set(Date.parse(pass.at), pass);
      continue;
    }
    const holdouts = parseHoldoutsLine(line);
    if (holdouts) reports.set(Date.parse(holdouts.at), holdouts);
  }

  if (metrics.size > 0) {
    await tx.query(
      `INSERT INTO mc.metrics_lines (factory, at, issue_number, merged_total, merged_simple,
          merged_complex, merged_continue, open_prs, send_backs, gate_refusals, correction_rounds,
          needs_owner_open, owner_questions_open, default_branch_checks, laps_total, laps_empty,
          laps_failed, health_actions)
        SELECT $1, m.at, $2, m.merged_total, m.merged_simple, m.merged_complex, m.merged_continue,
          m.open_prs, m.send_backs, m.gate_refusals, m.correction_rounds, m.needs_owner_open,
          m.owner_questions_open, m.default_branch_checks, m.laps_total, m.laps_empty,
          m.laps_failed, m.health_actions
        FROM jsonb_to_recordset($3::jsonb) AS m(at timestamptz, merged_total integer,
          merged_simple integer, merged_complex integer, merged_continue integer,
          open_prs integer, send_backs integer, gate_refusals integer, correction_rounds integer,
          needs_owner_open integer, owner_questions_open integer, default_branch_checks text,
          laps_total integer, laps_empty integer, laps_failed integer, health_actions integer)
        ON CONFLICT (factory, at) DO UPDATE SET issue_number = EXCLUDED.issue_number,
          merged_total = EXCLUDED.merged_total, merged_simple = EXCLUDED.merged_simple,
          merged_complex = EXCLUDED.merged_complex, merged_continue = EXCLUDED.merged_continue,
          open_prs = EXCLUDED.open_prs, send_backs = EXCLUDED.send_backs,
          gate_refusals = EXCLUDED.gate_refusals, correction_rounds = EXCLUDED.correction_rounds,
          needs_owner_open = EXCLUDED.needs_owner_open,
          owner_questions_open = EXCLUDED.owner_questions_open,
          default_branch_checks = EXCLUDED.default_branch_checks,
          laps_total = EXCLUDED.laps_total, laps_empty = EXCLUDED.laps_empty,
          laps_failed = EXCLUDED.laps_failed, health_actions = EXCLUDED.health_actions`,
      [
        factory,
        issue,
        [...metrics.values()].map((m) => ({
          at: m.at,
          merged_total: m.merged.total,
          merged_simple: m.merged.simple,
          merged_complex: m.merged.complex,
          merged_continue: m.merged.continue,
          open_prs: m.openPrs,
          send_backs: m.sendBacks,
          gate_refusals: m.gateRefusals,
          correction_rounds: m.correctionRounds,
          needs_owner_open: m.needsOwnerOpen,
          owner_questions_open: m.ownerQuestionsOpen,
          default_branch_checks: m.defaultBranchChecks,
          laps_total: m.laps.total,
          laps_empty: m.laps.empty,
          laps_failed: m.laps.failed,
          health_actions: m.healthActions,
        })),
      ],
    );
  }

  if (reports.size === 0) return;
  const stored = await tx.query(
    `INSERT INTO mc.holdout_reports (factory, at, issue_number, sha)
      SELECT $1, h.at, $2, h.sha FROM jsonb_to_recordset($3::jsonb) AS h(at timestamptz, sha text)
      ON CONFLICT (factory, at) DO UPDATE SET issue_number = EXCLUDED.issue_number,
        sha = EXCLUDED.sha
      RETURNING id, (extract(epoch FROM at) * 1000)::bigint AS at_ms`,
    [factory, issue, [...reports.values()].map(({ at, sha }) => ({ at, sha }))],
  );
  const idAt = new Map(stored.map((r) => [Number(r.at_ms), r.id]));
  const verdicts = [...reports].flatMap(([at, report]) => {
    // A scenario listed twice on one line keeps its last verdict, as upserting in turn did.
    const byScenario = new Map(report.holdouts.map((h) => [h.id, h]));
    return [...byScenario.values()].map((h) => ({
      report_id: idAt.get(at),
      scenario_id: h.id,
      verdict: h.verdict,
      issue_number: h.issue,
    }));
  });
  await tx.query(
    `DELETE FROM mc.holdout_verdicts v
      USING jsonb_to_recordset($1::jsonb) AS r(report_id bigint, ids jsonb)
      WHERE v.report_id = r.report_id
        AND v.scenario_id NOT IN (SELECT jsonb_array_elements_text(r.ids))`,
    [
      [...reports].map(([at, report]) => ({
        report_id: idAt.get(at),
        ids: report.holdouts.map((h) => h.id),
      })),
    ],
  );
  if (verdicts.length === 0) return;
  await tx.query(
    `INSERT INTO mc.holdout_verdicts (report_id, scenario_id, verdict, issue_number)
      SELECT v.report_id, v.scenario_id, v.verdict, v.issue_number
      FROM jsonb_to_recordset($1::jsonb)
        AS v(report_id bigint, scenario_id text, verdict text, issue_number integer)
      ON CONFLICT (report_id, scenario_id) DO UPDATE SET verdict = EXCLUDED.verdict,
        issue_number = EXCLUDED.issue_number`,
    [verdicts],
  );
}

/**
 * The comment's row and whichever claim, release or review it is. A delivery older than the
 * stored comment writes nothing. Nothing records a deleted comment, so an older delivery that
 * arrives after the deletion brings it back.
 */
export async function writeComment(
  tx: Tx,
  factory: string,
  issue: Issue,
  comment: Comment,
): Promise<void> {
  const [current] = await tx.query(
    `INSERT INTO mc.comments (factory, id, issue_number, author, url, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (factory, id) DO UPDATE SET issue_number = EXCLUDED.issue_number,
        author = EXCLUDED.author, url = EXCLUDED.url, created_at = EXCLUDED.created_at,
        updated_at = EXCLUDED.updated_at
      WHERE mc.comments.updated_at <= EXCLUDED.updated_at
      RETURNING id`,
    [
      factory,
      comment.id,
      issue.number,
      comment.user.login,
      comment.html_url,
      comment.created_at,
      comment.updated_at,
    ],
  );
  if (!current) return;

  const claim = parseClaim(comment.body);
  if (claim) {
    await tx.query(
      `INSERT INTO mc.claims (factory, issue_number, run_id, route, area, claimed_at, claim_comment_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (factory, issue_number, run_id) DO UPDATE SET route = EXCLUDED.route,
          area = EXCLUDED.area, claimed_at = EXCLUDED.claimed_at,
          claim_comment_id = EXCLUDED.claim_comment_id`,
      [factory, issue.number, claim.runId, claim.route, claim.area, comment.created_at, comment.id],
    );
  }

  const released = parseClaimReleased(comment.body);
  if (released) {
    await tx.query(
      `INSERT INTO mc.claims (factory, issue_number, run_id, released_at, release_comment_id)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (factory, issue_number, run_id) DO UPDATE SET
          released_at = EXCLUDED.released_at, release_comment_id = EXCLUDED.release_comment_id`,
      [factory, issue.number, released.runId, comment.created_at, comment.id],
    );
  }

  const review = issue.pull_request ? parseReview(comment.body) : null;
  if (!review) {
    await tx.query('DELETE FROM mc.reviews WHERE factory = $1 AND comment_id = $2', [
      factory,
      comment.id,
    ]);
    return;
  }
  await tx.query(
    `INSERT INTO mc.reviews (factory, comment_id, pr_number, outcome, route, sha, reason, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (factory, comment_id) DO UPDATE SET pr_number = EXCLUDED.pr_number,
        outcome = EXCLUDED.outcome, route = EXCLUDED.route, sha = EXCLUDED.sha,
        reason = EXCLUDED.reason, created_at = EXCLUDED.created_at`,
    [
      factory,
      comment.id,
      issue.number,
      review.outcome,
      review.route,
      review.outcome === 'merged' ? review.sha : null,
      review.outcome === 'refused' ? review.reason : null,
      comment.created_at,
    ],
  );
}

export async function deleteComment(tx: Tx, factory: string, id: number): Promise<void> {
  await tx.query('DELETE FROM mc.comments WHERE factory = $1 AND id = $2', [factory, id]);
  await tx.query('DELETE FROM mc.reviews WHERE factory = $1 AND comment_id = $2', [factory, id]);
}

async function deleteLabel(tx: Tx, factory: string, name: string): Promise<void> {
  await tx.query('DELETE FROM mc.issue_labels WHERE factory = $1 AND label = $2', [factory, name]);
}

async function renameLabel(tx: Tx, factory: string, from: string, to: string): Promise<void> {
  await tx.query(
    `INSERT INTO mc.issue_labels (factory, issue_number, label)
      SELECT factory, issue_number, $3 FROM mc.issue_labels WHERE factory = $1 AND label = $2
      ON CONFLICT DO NOTHING`,
    [factory, from, to],
  );
  await deleteLabel(tx, factory, from);
}

export async function writePullRequest(tx: Tx, factory: string, pr: PullRequest): Promise<void> {
  const [current] = await tx.query(
    `INSERT INTO mc.pull_requests (factory, number, title, state, merged_at, head_sha, url,
        created_at, updated_at, closed_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT (factory, number) DO UPDATE SET title = EXCLUDED.title, state = EXCLUDED.state,
        merged_at = EXCLUDED.merged_at, head_sha = EXCLUDED.head_sha, url = EXCLUDED.url,
        created_at = EXCLUDED.created_at, updated_at = EXCLUDED.updated_at,
        closed_at = EXCLUDED.closed_at
      WHERE mc.pull_requests.updated_at <= EXCLUDED.updated_at
      RETURNING number`,
    [
      factory,
      pr.number,
      pr.title,
      pr.state,
      pr.merged_at,
      pr.head.sha,
      pr.html_url,
      pr.created_at,
      pr.updated_at,
      pr.closed_at,
    ],
  );
  if (!current) return;
  await replaceSet(
    tx,
    'mc.pull_request_issues',
    { factory, pr_number: pr.number },
    'issue_number',
    'integer',
    parseClosingIssues(pr.body ?? ''),
  );
}

/**
 * A pin is written with its resolved full sha (`VersionCommit.archonSha`), or with none while it is
 * unresolved, so the version strip shows it at once and the map waits for the next backfill. An
 * unresolved write never clears a sha already stored.
 */
export async function writeCommits(tx: Tx, commits: VersionCommit[]): Promise<void> {
  for (const commit of commits) {
    const pin = parsePin(commit.message);
    if (pin) {
      await tx.query(
        `INSERT INTO mc.pins (sha, archon_sha, reason, hypothesis, measure, committed_at)
          VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT (sha) DO UPDATE SET
            archon_sha = coalesce(EXCLUDED.archon_sha, mc.pins.archon_sha),
            reason = EXCLUDED.reason, hypothesis = EXCLUDED.hypothesis,
            measure = EXCLUDED.measure, committed_at = EXCLUDED.committed_at`,
        [
          commit.id,
          commit.archonSha ?? null,
          pin.reason,
          pin.hypothesis,
          pin.measure,
          commit.timestamp,
        ],
      );
    }
    const verdict = parseVerdict(commit.message);
    if (verdict) {
      await tx.query(
        `INSERT INTO mc.verdicts (sha, pin, verdict, sentence, committed_at)
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (sha) DO UPDATE SET pin = EXCLUDED.pin, verdict = EXCLUDED.verdict,
            sentence = EXCLUDED.sentence, committed_at = EXCLUDED.committed_at`,
        [commit.id, verdict.pin, verdict.verdict, verdict.sentence, commit.timestamp],
      );
    }
  }
}

/** `DECISIONS.md` on the default branch is the whole truth: entries it no longer has go. */
export async function replaceDecisions(tx: Tx, text: string): Promise<void> {
  const { entries } = parseDecisions(text);
  await tx.query(
    `DELETE FROM mc.decisions d WHERE NOT EXISTS (
      SELECT 1 FROM jsonb_to_recordset($1::jsonb) AS e(date date, title text)
      WHERE e.date = d.date AND e.title = d.title)`,
    [entries.map(({ date, title }) => ({ date, title }))],
  );
  for (const e of entries) {
    await tx.query(
      `INSERT INTO mc.decisions (date, title, decision, why, replaces, version)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (date, title) DO UPDATE SET decision = EXCLUDED.decision, why = EXCLUDED.why,
          replaces = EXCLUDED.replaces, version = EXCLUDED.version`,
      [e.date, e.title, e.decision, e.why, e.replaces, e.version],
    );
  }
}
