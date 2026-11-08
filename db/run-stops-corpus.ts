import type { StopClass } from '../app/lib/failures';

/**
 * Error lines from this factory's runs, each with the class mc.stop_class must give it and where it
 * came from: Archon's logs on the factory machine, the line a pinned-pack script throws, or the
 * wording of issue #513.
 */
export const STOP_CORPUS: readonly (readonly [line: string, cls: StopClass, source: string])[] = [
  [
    'Could not persist node_skipped for ship__deliver__ci-changed: deadlock detected: deadlock detected',
    'transient',
    'archon log',
  ],
  [
    'gh: HTTP 502: Bad Gateway (https://api.github.com/repos/a/b/pulls/77)',
    'transient',
    'issue #513 (GitHub 502)',
  ],
  [
    'gh: HTTP 504: Gateway Timeout (https://api.github.com/repos/a/b/pulls/77)',
    'transient',
    'issue #513 (GitHub 504)',
  ],
  [
    "Node 'check-app' failed: the provider's usage or credit limit is used up (resets 2026-10-19T20:00:00.000Z). Resume the run once it reopens: You've hit your weekly limit · resets Oct 19, 3pm (America/Chicago)",
    'transient',
    'archon log',
  ],
  [
    "Node 'deliver__review__tests' failed: SDK returned error — 429 status code (no body)",
    'transient',
    'archon log',
  ],
  [
    "Claude API error (rate_limit): You've hit your session limit · resets 3pm (America/Chicago)",
    'transient',
    'archon log',
  ],
  [
    'Claude API error (rate_limit): Fable 5.1 requires usage credits. Switch to another model, or manage usage credits at claude.ai/settings/usage?from=cc_cli_limit_message, to continue.',
    'transient',
    'archon log',
  ],
  [
    'Failed to get workflow run status: Connection terminated unexpectedly',
    'transient',
    'archon log',
  ],
  [
    'Failed to get workflow run status: getaddrinfo ENOTFOUND ep-x.neon.tech',
    'transient',
    'archon log',
  ],
  [
    'Failed to get workflow run status: timeout exceeded when trying to connect',
    'transient',
    'archon log',
  ],
  [
    "Node 'review' failed: provider reported transient: API Error: Can't reach the API server — check your internet or DNS (ENOTFOUND)",
    'transient',
    'archon log',
  ],
  ['Error: connect ETIMEDOUT 140.82.112.3:443', 'transient', 'PRD 4.8 (infrastructure)'],
  [
    "Node 'pick' failed: provider reported auth: Failed to authenticate. API Error: 401 OAuth access token has expired. Re-authenticate to continue.",
    'config',
    'archon log',
  ],
  ['gh: Bad credentials (HTTP 401)', 'config', 'PRD 4.8 (authentication)'],
  [
    "Node 'pick' failed: the provider's configuration must be fixed before it can run; retrying will not help: Cannot list Claude plugins (`claude plugin list --json` failed): killed by SIGTERM",
    'config',
    'archon log',
  ],
  [
    'Node round binding pr_url is missing for workflow archon-build-queue',
    'config',
    'issue #513 (a missing binding)',
  ],
  ['No schedule found for workflow archon-intake', 'config', 'issue #513 (a missing schedule)'],
  [
    'check must write app-check/result.json and app-check/report.md',
    'environment',
    'pack queue/factory/app-check/scripts/evidence.ts',
  ],
  [
    'git merge --no-edit 4f2a9c1d0b7e failed: CONFLICT (content): Merge conflict in app/page.tsx',
    'environment',
    'pack queue/factory/app-check/scripts/prepare.ts',
  ],
  [
    'git push origin HEAD:refs/heads/archon/task-42 refused: ! [rejected] main -> main (non-fast-forward)',
    'environment',
    'pack queue/sdlc/.shared/push.ts',
  ],
  [
    'git push origin HEAD:refs/heads/archon/task-42 refused: ! [rejected] (stale info)',
    'environment',
    'pack queue/sdlc/.shared/push.ts',
  ],
  [
    'stale: pull request head changed',
    'environment',
    'pack queue/factory/app-check/scripts/publish.ts',
  ],
  [
    "Node 'check-app' did not complete: the app check ended before it wrote a result",
    'environment',
    'archon log',
  ],
  ['fatal: not a git repository (or any of the parent directories): .git', 'environment', 'git'],
  [
    'ENOENT: no such file or directory, open C:workcheckoutapp-check\result.json',
    'environment',
    'issue #513 (a missing checkout)',
  ],
  ['No issue matched the query', 'input', 'issue #513'],
  ['Invalid argument: --round must be a number', 'input', 'issue #513 (a bad argument)'],
  ['black-box app check failed', 'code', 'pack queue/factory/app-check/scripts/publish.ts'],
  [
    'app-check FAIL: criterion 3 shows no rows on the board',
    'code',
    'issue #513 (a red app-check finding)',
  ],
  ['bun test: 3 tests failed in app/lib/health.test.ts', 'code', 'issue #513 (a test failure)'],
  ['3 tests failed on PR #401', 'code', 'a PR number is not a status code'],
  ['No issue matched #1401', 'input', 'an issue number is not a status code'],
  ['git merge --no-edit failed on pulls/1429', 'environment', 'a pulls path is not a status code'],
  [
    '3 tests failed, see #401 status',
    'code',
    'the reference strip: a ref before status is not 401',
  ],
  [
    'git merge --no-edit failed on pulls/429 status check',
    'environment',
    'the reference strip: a pulls path is not 429',
  ],
  ['git merge --no-edit failed with HTTP 4290', 'environment', 'a longer number is not 429'],
  ['build exited 1: 3 type errors remain', 'code', 'pack queue'],
  [
    'app/lib/board.ts(12,5): error TS2322: Type string is not assignable to type number',
    'code',
    'tsc',
  ],
  [
    'bun test: 3 tests failed in /worktrees/archon/task-42/app/lib/health.test.ts',
    'code',
    'review R1 (a code failure naming a worktree path)',
  ],
  [
    String.raw`app-check FAIL: stale numbers shown on the board in checkout C:\w\run-1`,
    'code',
    'review R1 (a FAIL finding naming stale and a checkout)',
  ],
  [
    String.raw`C:\worktrees\task-42\app\board.ts(12,5): error TS2322: Type string is not assignable to type number`,
    'code',
    'review R1 (a type error under a worktree path)',
  ],
  [
    'git merge --no-edit origin/main: CONFLICT (content): Merge conflict in .archon/workflows/factory/app-check/fixtures/fail.stubs.yaml',
    'environment',
    'review R8 (a merge conflict in a path named fail)',
  ],
  [
    'git push origin HEAD:refs/heads/build/530-review-findings-show-on-the-board-1a2b3c4d refused: ! [rejected] (stale info)',
    'environment',
    'review R8 (a refused push to a branch named findings)',
  ],
  [
    'git push origin HEAD:refs/heads/fix-typecheck refused: To /tmp/r.git\n ! [rejected]        HEAD -> fix-typecheck (fetch first)',
    'environment',
    'review R8 (a refused push whose branch has no slash in git stderr)',
  ],
  [
    'git merge --no-edit origin/main: CONFLICT (content): Merge conflict in fixtures/1a2b3c4d-fail.yaml',
    'environment',
    'review R8 (an id before the code word in a conflicted file)',
  ],
  [
    'git merge --no-edit origin/main: CONFLICT (content): Merge conflict in findings.md',
    'environment',
    'review R8 (a conflicted file without a slash)',
  ],
  [
    "ENOENT: no such file or directory, open '/w/runs/1a2b3c4d-findings.json'",
    'environment',
    'review R8 (an id before the code word in an ENOENT path)',
  ],
  [
    "ENOENT: no such file or directory, open '/w/runs/b7c7da69-95e4-402c-af18-7c67e54f59df-findings.json'",
    'environment',
    'review R12 (a uuid before the code word in an ENOENT path)',
  ],
];
