-- The architecture at one version (PRD 11.4): what parsers/pack.ts reads from the pack at an Archon
-- commit and the factory template at a factory commit. Every row is keyed by that pair.

CREATE TABLE IF NOT EXISTS mc.arch_versions (
  archon_sha text NOT NULL,
  factory_sha text NOT NULL,
  parsed_at timestamptz NOT NULL,
  PRIMARY KEY (archon_sha, factory_sha)
);

CREATE TABLE IF NOT EXISTS mc.arch_workflows (
  archon_sha text NOT NULL,
  factory_sha text NOT NULL,
  name text NOT NULL,
  description text,
  model text,
  file text NOT NULL,
  yaml text NOT NULL,
  PRIMARY KEY (archon_sha, factory_sha, name)
);

-- Every node of a workflow's expanded tree, in declaration order; path is unique within the root
-- workflow and parent_path is its include or loop-group ancestor.
CREATE TABLE IF NOT EXISTS mc.arch_steps (
  archon_sha text NOT NULL,
  factory_sha text NOT NULL,
  workflow text NOT NULL,
  path text NOT NULL,
  parent_path text,
  position integer NOT NULL,
  step_id text NOT NULL,
  kind text NOT NULL,
  description text,
  model text,
  when_condition text,
  depends_on text[] NOT NULL DEFAULT '{}',
  trigger_rule text,
  include text,
  command text,
  command_file text,
  script text,
  script_file text,
  runtime text,
  bash text,
  prompt text,
  defined_in text NOT NULL,
  file text NOT NULL,
  PRIMARY KEY (archon_sha, factory_sha, workflow, path)
);

CREATE TABLE IF NOT EXISTS mc.arch_edges (
  archon_sha text NOT NULL,
  factory_sha text NOT NULL,
  workflow text NOT NULL,
  from_path text NOT NULL,
  to_path text NOT NULL,
  PRIMARY KEY (archon_sha, factory_sha, workflow, from_path, to_path)
);

-- Command and instruction files, by pack-relative path.
CREATE TABLE IF NOT EXISTS mc.arch_texts (
  archon_sha text NOT NULL,
  factory_sha text NOT NULL,
  path text NOT NULL,
  text text NOT NULL,
  PRIMARY KEY (archon_sha, factory_sha, path)
);

CREATE TABLE IF NOT EXISTS mc.arch_scripts (
  archon_sha text NOT NULL,
  factory_sha text NOT NULL,
  path text NOT NULL,
  text text NOT NULL,
  PRIMARY KEY (archon_sha, factory_sha, path)
);

-- A step's inline agents; instruction_file names a row of mc.arch_texts.
CREATE TABLE IF NOT EXISTS mc.arch_subagents (
  archon_sha text NOT NULL,
  factory_sha text NOT NULL,
  workflow text NOT NULL,
  step_path text NOT NULL,
  name text NOT NULL,
  description text,
  prompt text,
  instruction_file text,
  PRIMARY KEY (archon_sha, factory_sha, workflow, step_path, name)
);

-- The factory template's hook files, with the agents each lets through.
CREATE TABLE IF NOT EXISTS mc.arch_hooks (
  archon_sha text NOT NULL,
  factory_sha text NOT NULL,
  path text NOT NULL,
  text text NOT NULL,
  admitted_agents text[] NOT NULL DEFAULT '{}',
  PRIMARY KEY (archon_sha, factory_sha, path)
);
