-- The GitHub mirror (PRD 11.2), keyed by factory and GitHub number or id. Bodies are never stored:
-- only the facts the parsers in parsers/ take from them.

CREATE TABLE IF NOT EXISTS mc.issues (
  factory text NOT NULL,
  number integer NOT NULL,
  title text NOT NULL,
  state text NOT NULL CHECK (state IN ('open', 'closed')),
  phase text,
  url text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  closed_at timestamptz,
  PRIMARY KEY (factory, number)
);

CREATE TABLE IF NOT EXISTS mc.issue_labels (
  factory text NOT NULL,
  issue_number integer NOT NULL,
  label text NOT NULL,
  PRIMARY KEY (factory, issue_number, label)
);

-- One row per `Depends on: #n` edge in an issue body.
CREATE TABLE IF NOT EXISTS mc.issue_dependencies (
  factory text NOT NULL,
  issue_number integer NOT NULL,
  depends_on integer NOT NULL,
  PRIMARY KEY (factory, issue_number, depends_on)
);

CREATE TABLE IF NOT EXISTS mc.comments (
  factory text NOT NULL,
  id bigint NOT NULL,
  issue_number integer NOT NULL,
  author text NOT NULL,
  url text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (factory, id)
);

CREATE TABLE IF NOT EXISTS mc.pull_requests (
  factory text NOT NULL,
  number integer NOT NULL,
  title text NOT NULL,
  state text NOT NULL CHECK (state IN ('open', 'closed')),
  merged_at timestamptz,
  head_sha text NOT NULL,
  url text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  closed_at timestamptz,
  PRIMARY KEY (factory, number)
);

-- The issues a pull request closes.
CREATE TABLE IF NOT EXISTS mc.pull_request_issues (
  factory text NOT NULL,
  pr_number integer NOT NULL,
  issue_number integer NOT NULL,
  PRIMARY KEY (factory, pr_number, issue_number)
);

-- One row per claim: its `Loop claim:` comment fills route, area and claimed_at, its
-- `Loop claim released:` comment fills released_at. A claim is live while released_at is null.
CREATE TABLE IF NOT EXISTS mc.claims (
  factory text NOT NULL,
  issue_number integer NOT NULL,
  run_id uuid NOT NULL,
  route text,
  area text,
  claimed_at timestamptz,
  claim_comment_id bigint,
  released_at timestamptz,
  release_comment_id bigint,
  PRIMARY KEY (factory, issue_number, run_id)
);

-- One row per `Loop review:` comment.
CREATE TABLE IF NOT EXISTS mc.reviews (
  factory text NOT NULL,
  comment_id bigint NOT NULL,
  pr_number integer NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('merged', 'refused', 'sent-back')),
  route text NOT NULL,
  sha text,
  reason text,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (factory, comment_id)
);

-- One row per question in the manager's `Owner decisions needed` issue.
CREATE TABLE IF NOT EXISTS mc.owner_questions (
  factory text NOT NULL,
  issue_number integer NOT NULL,
  question_number integer NOT NULL,
  question text NOT NULL,
  options jsonb NOT NULL DEFAULT '[]',
  recommendation text,
  default_option text,
  default_at timestamptz,
  raised_at timestamptz NOT NULL,
  closed_at timestamptz,
  PRIMARY KEY (factory, issue_number, question_number)
);

-- One row per manager pass line in the `Loop metrics` issue.
CREATE TABLE IF NOT EXISTS mc.metrics_lines (
  factory text NOT NULL,
  at timestamptz NOT NULL,
  issue_number integer NOT NULL,
  merged_total integer NOT NULL,
  merged_simple integer NOT NULL,
  merged_complex integer NOT NULL,
  merged_continue integer NOT NULL,
  open_prs integer NOT NULL,
  send_backs integer NOT NULL,
  gate_refusals integer NOT NULL,
  correction_rounds integer NOT NULL,
  needs_owner_open integer NOT NULL,
  owner_questions_open integer NOT NULL,
  default_branch_checks text NOT NULL,
  laps_total integer NOT NULL,
  laps_empty integer NOT NULL,
  laps_failed integer NOT NULL,
  health_actions integer NOT NULL,
  PRIMARY KEY (factory, at)
);

-- One row per `holdouts at <sha>:` line; its verdicts are in mc.holdout_verdicts.
CREATE TABLE IF NOT EXISTS mc.holdout_reports (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  factory text NOT NULL,
  at timestamptz NOT NULL,
  issue_number integer NOT NULL,
  sha text NOT NULL,
  UNIQUE (factory, at)
);

-- A default-branch holdout verdict: scenario id and verdict only, never text (PRD 6.3, 11.7).
CREATE TABLE IF NOT EXISTS mc.holdout_verdicts (
  report_id bigint NOT NULL,
  scenario_id text NOT NULL CHECK (scenario_id ~ '^H-[0-9]{2,}$'),
  verdict text NOT NULL CHECK (verdict IN ('PASS', 'FAIL', 'INCOMPLETE')),
  issue_number integer,
  PRIMARY KEY (report_id, scenario_id)
);
