import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { pinnedArchonSha } from '../../function/ingest';
import {
  parseClaim,
  parseClaimReleased,
  parseDependsOn,
  parseOwnerQuestions,
  parsePhase,
  parseReview,
} from '../../parsers/comments';
import { parsePin, parseVerdict } from '../../parsers/commits';
import { parseDecisions } from '../../parsers/decisions';
import { parseHoldoutsLine, parseMetricsLine } from '../../parsers/metrics';
import type { PackVersion, Step } from '../../parsers/pack';
import type { FactoryEntry } from '../../server/factories';
import { failing, type Main, noArguments, runCli } from '../lib/cli';
import type { Db } from '../lib/db';
import { pgliteDb } from '../lib/pglite';
import { migrationsDir, readMigrationFiles, runMigrations } from '../migrate';
import { architectureSql, parseVersions, V2_EDITS } from './seed-architecture';
import { MARKER, scorecard } from './seed-report';
import { insert, json, type SqlRow } from './sql';
import { FACTORY, nodeBlock, REPOSITORY, WORKFLOW } from './write';

// Builds fixtures/seed.sql: the rows every panel is built against (PRD 12 item 3). Archon's rows
// are written first; the lap, step and app-check rows are then projected from them by SQL, so they
// are the rows the projection (PRD 11.4) produces. GitHub, pin and DECISIONS rows are what the
// repository's parsers take from literal texts, and the architecture rows are parsers/pack.ts's.

const USAGE =
  'usage: bun run fixture:seed (writes fixtures/seed.sql and fixtures/expected-scorecard.json)';

export const SEED_CODEBASE = '5eed0000-0000-4000-8000-000000000000';
const SECOND_CODEBASE = '5eed0000-0000-4000-8000-000000000001';
const MINUTE = 60_000;

const iso = (ms: number) => new Date(ms).toISOString();
const ms = (at: string) => Date.parse(at);
const fakeSha = (label: string) => new Bun.CryptoHasher('sha1').update(label).digest('hex');

function must<T>(value: T | null, what: string): T {
  if (value === null) throw new Error(`${what} does not parse`);
  return value;
}

// --- Versions: a pin each, with the trailers the version strip reads (PRD 4.2, 11.5) ------------

type VersionName = 'V1' | 'V2' | 'V3';

type VersionSpec = {
  name: VersionName;
  digest: string;
  archonSha: string;
  pinSha: string;
  pinMessage: string;
  pinnedAt: string;
};

const V2_ARCHON = '2b7c4e9a1f0d3c5b6a7e8f9d0c1b2a3f4e5d6c7b';
const V3_ARCHON = '7e1d0c9b8a7f6e5d4c3b2a1f0e9d8c7b6a5f4e3d';

function versionSpecs(v1Archon: string): VersionSpec[] {
  const specs: VersionSpec[] = [
    {
      name: 'V1',
      digest: `sha256:${'a1'.repeat(32)}`,
      archonSha: v1Archon,
      pinSha: fakeSha('pin V1'),
      pinMessage: `Pin Archon ${v1Archon}: holdouts fenced in the repository; the complex route runs dev's ship-block

Hypothesis: complex laps finish faster and are sent back less.
Measure: complex-route lap-hours per merge and send-backs per merge, over at least 10 complex laps.`,
      pinnedAt: '2026-09-30T18:00:00Z',
    },
    {
      name: 'V2',
      digest: `sha256:${'b2'.repeat(32)}`,
      archonSha: V2_ARCHON,
      pinSha: fakeSha('pin V2'),
      // Names its Archon commit by short sha, as real pins do (#157).
      pinMessage: `Pin Archon ${V2_ARCHON.slice(0, 8)}: the loop drops the briefs step and tallies every lap

Measure: lap-hours per merge, lower, over at least 12 laps.`,
      pinnedAt: '2026-10-09T18:00:00Z',
    },
    {
      name: 'V3',
      digest: `sha256:${'c3'.repeat(32)}`,
      archonSha: V3_ARCHON,
      pinSha: fakeSha('pin V3'),
      pinMessage: `Pin Archon ${V3_ARCHON}: follow dev's pack`,
      pinnedAt: '2026-10-19T18:00:00Z',
    },
  ];
  for (const spec of specs) {
    // A panel that joins `Verdict:` or `Version:` to the Archon sha instead of the pin's fails here.
    if (spec.pinSha.slice(0, 8) === spec.archonSha.slice(0, 8)) {
      throw new Error(`${spec.name}'s pin and Archon shas share a prefix`);
    }
  }
  return specs;
}

// --- Laps ---------------------------------------------------------------------------------------

type Outcome = 'merged' | 'sent-back' | 'gate-refused' | 'needs-owner' | 'nothing' | 'failed';
type PickRoute = 'simple' | 'complex' | 'continue' | 'none';
type Line = {
  kind: 'criterion' | 'holdout' | 'probe' | 'defect';
  verdict: string;
  text: string;
  preExisting?: string;
};

type LapSpec = {
  outcome: Outcome;
  route: PickRoute;
  issue?: number;
  /** check-app lines after the three every checked lap has. */
  lines?: Line[];
  /** The failing build step's error, for a failed lap. */
  error?: string;
  /** The merge gate's reason, for a gate-refused lap. */
  refusal?: string;
  /** The build step's completion carries `structured_output` as a jsonb string. */
  strayOutput?: boolean;
};

type UnfinishedSpec = {
  label: string;
  status: 'running' | 'paused' | 'pending';
  route: PickRoute;
  issue?: number;
  start: string;
  /** Steps finished at the seed's moment; a running run has the next one started. */
  done: number;
  providerEvents?: number;
};

const failingHoldout = (text: string, preExisting = ''): Line => ({
  kind: 'holdout',
  verdict: 'FAIL',
  text,
  preExisting,
});

const LAPS: Record<VersionName, LapSpec[]> = {
  V1: [
    { outcome: 'merged', route: 'simple', issue: 1 },
    {
      outcome: 'sent-back',
      route: 'simple',
      issue: 2,
      lines: [failingHoldout(`H-02 ${MARKER} the lanes panel lists one lap twice`)],
    },
    { outcome: 'merged', route: 'continue', issue: 2 },
    {
      outcome: 'gate-refused',
      route: 'simple',
      issue: 3,
      refusal: 'it changes .claude/settings.json, which only the owner changes',
    },
    { outcome: 'needs-owner', route: 'simple', issue: 4 },
    { outcome: 'nothing', route: 'none' },
    { outcome: 'failed', route: 'simple', issue: 3, error: '429 usage limit reached' },
    {
      outcome: 'gate-refused',
      route: 'continue',
      issue: 3,
      refusal: 'the commit does not contain the current default branch',
    },
    { outcome: 'needs-owner', route: 'continue', issue: 4 },
    {
      outcome: 'sent-back',
      route: 'simple',
      issue: 3,
      lines: [failingHoldout(`H-03 ${MARKER} a failed lap shows no cause`, '#14')],
    },
    {
      outcome: 'failed',
      route: 'continue',
      issue: 3,
      error: '401 unauthorized: invalid x-api-key',
    },
    { outcome: 'merged', route: 'continue', issue: 3 },
  ],
  V2: [
    { outcome: 'merged', route: 'complex', issue: 5 },
    { outcome: 'merged', route: 'simple', issue: 6, strayOutput: true },
    { outcome: 'nothing', route: 'none' },
    {
      outcome: 'sent-back',
      route: 'simple',
      issue: 7,
      lines: [failingHoldout(`H-04 ${MARKER} the scorecard names no laps under a number`)],
    },
    { outcome: 'merged', route: 'continue', issue: 7 },
    { outcome: 'failed', route: 'simple', issue: 8, error: 'fetch failed: ECONNRESET' },
    {
      outcome: 'gate-refused',
      route: 'simple',
      issue: 8,
      refusal: 'it changes .github/workflows/ci.yml, which only the owner changes',
    },
    {
      outcome: 'needs-owner',
      route: 'simple',
      issue: 13,
      lines: [failingHoldout(`H-06 ${MARKER} the diff shows a removed step as changed`)],
    },
    { outcome: 'failed', route: 'simple', issue: 8, error: 'build exited 1: 3 type errors remain' },
    { outcome: 'nothing', route: 'none' },
    { outcome: 'merged', route: 'complex', issue: 8 },
    { outcome: 'failed', route: 'simple', issue: 9, error: 'usage limit reached (429)' },
  ],
  V3: [
    { outcome: 'merged', route: 'simple', issue: 10 },
    {
      outcome: 'sent-back',
      route: 'simple',
      issue: 9,
      lines: [
        failingHoldout(`${MARKER} a step that failed shows as running`),
        {
          kind: 'defect',
          verdict: 'DEFECT',
          text: 'the version strip overlaps the scorecard at 1280 px',
        },
      ],
    },
    { outcome: 'failed', route: 'continue', issue: 9, error: '401 unauthorized' },
  ],
};

/** V3's runs that had not finished at the seed's moment: two on different steps, one far back. */
const V3_UNFINISHED: UnfinishedSpec[] = [
  {
    label: 'A',
    status: 'running',
    route: 'simple',
    issue: 11,
    start: '2026-10-21T09:00:00Z',
    done: 2,
  },
  {
    label: 'B',
    status: 'running',
    route: 'simple',
    issue: 12,
    start: '2026-10-24T10:00:00Z',
    done: 4,
    providerEvents: 2,
  },
  {
    label: 'P',
    status: 'paused',
    route: 'simple',
    issue: 16,
    start: '2026-10-23T15:00:00Z',
    done: 2,
  },
  { label: 'Q', status: 'pending', route: 'none', start: '2026-10-24T11:55:00Z', done: 0 },
];

/** Lap k's start in each version: V2's first two laps run side by side. */
const LAP_STARTS: Record<VersionName, (k: number) => number> = {
  V1: (k) => ms('2026-10-01T08:00:00Z') + 120 * MINUTE * k,
  V2: (k) => ms('2026-10-10T08:00:00Z') + 120 * MINUTE * Math.max(k - 1, 0),
  V3: (k) => ms('2026-10-20T08:00:00Z') + 120 * MINUTE * k,
};

const LAP_MINUTES: Record<Outcome, number> = {
  merged: 90,
  'sent-back': 60,
  'gate-refused': 60,
  'needs-owner': 60,
  nothing: 5,
  failed: 20,
};

const STEP_TIMES: Record<string, { minutes: number; cost?: number }> = {
  pick: { minutes: 3, cost: 0.1 },
  claim: { minutes: 1 },
  build: { minutes: 20, cost: 1.2 },
  ship__intel: { minutes: 20, cost: 1.2 },
  ship__outcome: { minutes: 1 },
  subject: { minutes: 1 },
  briefs: { minutes: 1 },
  'check-app': { minutes: 20, cost: 0.8 },
  evidence: { minutes: 1 },
  review: { minutes: 10, cost: 0.4 },
  land: { minutes: 2 },
  release: { minutes: 1 },
  tally: { minutes: 1 },
};

/** A failed lap's build step fails after this long. */
const FAILING_MINUTES = 10;

const TOKENS = { input: 48_210, output: 6_904, cacheRead: 39_877, cacheWrite: 8_333 };

type Event = { id: string; type: string; step: string; at: number; data: Record<string, unknown> };

type Run = {
  id: string;
  label: string;
  version: VersionSpec;
  status: string;
  route: PickRoute;
  issue: number | null;
  pr: number | null;
  outcome: Outcome | null;
  start: number;
  end: number | null;
  head: string;
  base: string;
  spec: LapSpec | null;
  events: Event[];
};

type Schema = { required?: string[]; properties?: Record<string, Schema>; items?: Schema };

/** The loop as one version's pack declares it: its top-level node ids and every node by name. */
type Loop = {
  ids: string[];
  steps: Map<string, Step>;
  doc: { nodes: { id: string; output_format?: Schema }[] };
};

function loopOf(version: PackVersion): Loop {
  const workflow = version.workflows.find((w) => w.name === WORKFLOW);
  if (!workflow) throw new Error(`the pack has no ${WORKFLOW} workflow`);
  const steps = new Map<string, Step>();
  for (const step of workflow.steps) {
    steps.set(step.id, step);
    // Archon names an included node `<include node>__<inner node>`.
    for (const inner of step.steps) steps.set(`${step.id}__${inner.id}`, inner);
  }
  return {
    ids: workflow.steps.map((s) => s.id),
    steps,
    doc: Bun.YAML.parse(workflow.yaml) as Loop['doc'],
  };
}

const topLevel = (step: string) => step.split('__')[0] ?? step;

/** The steps a lap of `outcome` runs, in order, in the loop it ran. */
function stepsFor(outcome: Outcome, route: PickRoute, loop: Loop): string[] {
  const build = route === 'complex' ? ['ship__intel', 'ship__outcome'] : ['build'];
  const checked = [
    'pick',
    'claim',
    ...build,
    'subject',
    'briefs',
    'check-app',
    'evidence',
    'review',
  ];
  const landed = outcome === 'merged' || outcome === 'gate-refused' ? ['land'] : [];
  const all =
    outcome === 'nothing'
      ? ['pick']
      : outcome === 'failed'
        ? ['pick', 'claim', build[0] ?? 'build']
        : [...checked, ...landed, 'release', 'tally'];
  return all.filter((step) => loop.ids.includes(topLevel(step)));
}

const ISSUE_AREAS: Record<number, string> = {
  1: 'server/*',
  2: 'scripts/fixture/*',
  3: 'scripts/migrate.ts',
  4: 'harness/*',
  5: 'db/migrations/*',
  6: 'parsers/*',
  7: 'fixtures/*',
  8: 'parsers/pack.ts',
  9: 'db/migrations/*',
  10: 'app/routes/versions.tsx',
  11: 'app/routes/scorecard.tsx',
  12: 'app/routes/decisions.tsx',
  13: 'app/routes/diff.tsx',
  14: 'app/routes/issues.tsx',
  15: 'app/routes/lanes.tsx',
  16: 'app/routes/owner.tsx',
};

const areaOf = (issue: number | null) => (issue === null ? '' : (ISSUE_AREAS[issue] ?? ''));

const LINE_PREFIX: Record<Line['kind'], string> = {
  criterion: 'C',
  probe: 'P',
  holdout: 'H',
  defect: 'D',
};

function checkLines(run: Run): Record<string, unknown>[] {
  const lines: Line[] = [
    { kind: 'criterion', verdict: 'PASS', text: `#${run.issue}: every acceptance criterion holds` },
    { kind: 'probe', verdict: 'OK', text: 'GET /api/health returns 200 on port 8851' },
    { kind: 'holdout', verdict: 'PASS', text: `H-01 ${MARKER} the user sees the home screen` },
    ...(run.spec?.lines ?? []),
  ];
  // Each kind numbers its own lines, as the pack's check-app reports them (`C1`, `P1`, `H1`, `D1`).
  const counts = new Map<string, number>();
  return lines.map((line, index) => {
    const evidence = `check-app/line-${index + 1}`;
    const n = (counts.get(line.kind) ?? 0) + 1;
    counts.set(line.kind, n);
    return {
      id: `${LINE_PREFIX[line.kind]}${n}`,
      kind: line.kind,
      verdict: line.verdict,
      text: line.text,
      evidence:
        line.kind === 'criterion' ? [`${evidence}.txt`, `${evidence}.png`] : [`${evidence}.txt`],
      pre_existing: line.preExisting ?? '',
      defect: '',
      carried_from: '',
    };
  });
}

const failingLines = (lines: Record<string, unknown>[]) =>
  lines.filter((line) => line.verdict === 'FAIL' || line.verdict === 'DEFECT');

function reviewOutput(run: Run, pr: string, lines: Record<string, unknown>[]) {
  const outcome =
    run.outcome === 'sent-back' || run.outcome === 'needs-owner' ? run.outcome : 'merge';
  const reasons = {
    merge: 'The app check passed with evidence and the diff matches the issue.',
    'sent-back': 'The change does not deliver the issue yet.',
    'needs-owner': 'It loosens a holdout judge, which only the owner approves.',
  };
  return {
    outcome,
    pr,
    sha: run.head,
    delivers: outcome === 'merge' ? 'all' : 'part',
    dispositions: failingLines(lines).map((line) => ({
      line: line.id,
      action: line.pre_existing === '' ? 'blocks' : 'pre-existing',
      file: (line.evidence as string[])[0],
      issue: line.pre_existing,
      reason: line.pre_existing === '' ? 'The change causes it.' : 'It fails on main too.',
    })),
    judge_changes:
      outcome === 'needs-owner'
        ? [{ file: 'harness/harness.config.json', change: 'raises a judge timeout', approval: '' }]
        : [],
    reason: reasons[outcome],
  };
}

/** The structured output of a loop step, shaped by the pinned pack's `output_format`. */
function outputFor(step: string, run: Run, at: number): Record<string, unknown> | undefined {
  const pr = run.pr === null ? '' : `#${run.pr}`;
  const lines = checkLines(run);
  const overall = failingLines(lines).length > 0 ? 'FAIL' : 'PASS';
  switch (step) {
    case 'pick':
      return run.route === 'none'
        ? {
            route: 'none',
            target: '',
            pr: '',
            confidence: 'high',
            depth: 'light',
            area: '',
            reason: 'Nothing is workable: every open item is claimed, waiting or with the owner.',
          }
        : {
            route: run.route,
            target: `#${run.issue}`,
            pr: run.route === 'continue' ? pr : '',
            confidence: 'high',
            depth: 'normal',
            area: areaOf(run.issue),
            reason: `#${run.issue} is the oldest workable item.`,
          };
    case 'claim':
      return { held: 'true', holder: run.id, reason: `run ${run.id} holds #${run.issue}` };
    case 'subject':
      return { pr, head: run.head, base: run.base, files: areaOf(run.issue), started: iso(at) };
    case 'check-app':
      return {
        pr,
        head: run.head,
        merged_with: run.base,
        lines,
        noticed: [],
        overall,
        summary:
          overall === 'PASS'
            ? 'Every criterion and holdout passes on the merged head.'
            : `${failingLines(lines).length} line fails on the merged head.`,
      };
    case 'evidence':
      return { ok: 'true', problems: '', overall, checked_at: iso(at) };
    case 'review':
      return reviewOutput(run, pr, lines);
    case 'land':
      return run.outcome === 'merged'
        ? { outcome: 'merged', reason: `Merged ${run.head.slice(0, 7)} into main.` }
        : { outcome: 'refused', reason: run.spec?.refusal ?? '' };
    default:
      return undefined;
  }
}

/** Throws unless `output` has exactly the keys the pinned pack requires of `step` (and its lines). */
function checkOutput(loop: Loop, step: string, output: Record<string, unknown> | undefined): void {
  const schema = loop.doc.nodes.find((node) => node.id === step)?.output_format;
  const same = (keys: string[], required: string[] | undefined) =>
    JSON.stringify([...keys].sort()) === JSON.stringify([...(required ?? [])].sort());
  if (!schema) {
    if (output !== undefined) throw new Error(`${step} declares no output_format`);
    return;
  }
  if (!output || !same(Object.keys(output), schema.required)) {
    throw new Error(`${step}'s output does not have the keys its output_format requires`);
  }
  const lineKeys = schema.properties?.lines?.items?.required;
  for (const line of (output.lines as Record<string, unknown>[] | undefined) ?? []) {
    if (!same(Object.keys(line), lineKeys)) throw new Error(`a ${step} line has the wrong keys`);
  }
}

function block(loop: Loop, step: string): Record<string, unknown> {
  const node = loop.steps.get(step);
  if (!node) throw new Error(`the loop has no step ${step}`);
  return nodeBlock(step, node.kind, node.command ?? step);
}

type NewEvent = (type: string, step: string, at: number, data: Record<string, unknown>) => void;

/**
 * The events of a run: each planned step back to back from its start, `done` of them finished
 * (the last failing on a failed lap) and, when `running`, the next one started; then, for a
 * finished run, a skip for every top-level node it did not run.
 */
function runEvents(run: Run, loop: Loop, planned: string[], done: number, running: boolean) {
  const push: NewEvent = (type, step, at, data) =>
    run.events.push({ id: '', type, step, at, data });
  let at = run.start;
  for (const [index, step] of planned.entries()) {
    if (index > done || (index === done && !running)) break;
    const node = block(loop, step);
    push('node_started', step, at, { ...node, timing: { startedAt: iso(at) } });
    if (index === done) break;
    const fails = run.outcome === 'failed' && index === planned.length - 1;
    const durationMs = (fails ? FAILING_MINUTES : (STEP_TIMES[step]?.minutes ?? 1)) * MINUTE;
    const timing = { startedAt: iso(at), durationMs };
    const startedAt = at;
    at += durationMs;
    if (fails) {
      push('node_failed', step, at, {
        ...node,
        timing,
        duration_ms: durationMs,
        error: run.spec?.error,
      });
      continue;
    }
    const output = outputFor(step, run, step === 'subject' ? startedAt : at);
    checkOutput(loop, step, output);
    push('node_completed', step, at, {
      ...node,
      timing,
      duration_ms: durationMs,
      ...(node.type === 'command'
        ? { tokens: TOKENS, cost_usd: STEP_TIMES[step]?.cost ?? 0, num_turns: 14 }
        : {}),
      node_output: output === undefined ? 'Done.' : JSON.stringify(output),
      ...(output === undefined
        ? {}
        : { structured_output: output, declared_fields: Object.keys(output) }),
      ...(run.spec?.strayOutput && step === 'build' ? { structured_output: '{}' } : {}),
    });
  }
  if (run.end === null) return;
  if (at > run.end) throw new Error(`${run.label}'s steps end after the lap`);
  const ran = new Set(planned.map(topLevel));
  for (const id of loop.ids) if (!ran.has(id)) push('node_skipped', id, at, block(loop, id));
}

const prOf = (issue: number) => 100 + issue;
const runId = (version: number, index: number) =>
  `5eed000${version}-0000-4000-8000-0000000000${index.toString(16).padStart(2, '0')}`;

function buildRuns(versions: VersionSpec[], loops: Record<VersionName, Loop>): Run[] {
  const runs: Run[] = [];
  for (const [v, version] of versions.entries()) {
    const loop = loops[version.name];
    for (const [k, spec] of LAPS[version.name].entries()) {
      const start = LAP_STARTS[version.name](k);
      const label = `${version.name} k${k}`;
      const run: Run = {
        id: runId(v + 1, k),
        label,
        version,
        status: spec.outcome === 'failed' ? 'failed' : 'completed',
        route: spec.route,
        issue: spec.issue ?? null,
        pr: spec.issue === undefined ? null : prOf(spec.issue),
        outcome: spec.outcome,
        start,
        end: start + LAP_MINUTES[spec.outcome] * MINUTE,
        head: fakeSha(`head ${label}`),
        base: fakeSha(`base ${label}`),
        spec,
        events: [],
      };
      const planned = stepsFor(spec.outcome, spec.route, loop);
      runEvents(run, loop, planned, planned.length, false);
      runs.push(run);
    }
  }
  const v3 = versions[2];
  if (!v3) throw new Error('the seed has three versions');
  for (const [index, spec] of V3_UNFINISHED.entries()) {
    const label = `V3 run ${spec.label}`;
    const planned = stepsFor('merged', spec.route, loops.V3);
    const run: Run = {
      id: runId(3, 10 + index),
      label,
      version: v3,
      status: spec.status,
      route: spec.route,
      issue: spec.issue ?? null,
      // A run past its build step has opened its pull request.
      pr:
        spec.issue !== undefined && spec.done > planned.indexOf('build') ? prOf(spec.issue) : null,
      outcome: null,
      start: ms(spec.start),
      end: null,
      head: fakeSha(`head ${label}`),
      base: fakeSha(`base ${label}`),
      spec: null,
      events: [],
    };
    runEvents(run, loops.V3, planned, spec.done, spec.status === 'running');
    const last = run.events.at(-1)?.at ?? run.start;
    for (let i = 1; i <= (spec.providerEvents ?? 0); i++) {
      run.events.push({
        id: '',
        type: 'provider_event',
        step: planned[spec.done] ?? '',
        at: last + i * 2 * MINUTE,
        data: {
          kind: 'tool_use',
          tool: 'Bash',
          input: { command: 'bun run serve -- --port 8851' },
        },
      });
    }
    runs.push(run);
  }
  let counter = 0;
  for (const run of runs) {
    for (const event of run.events) {
      event.id = `5eedeeee-0000-4000-8000-${String(++counter).padStart(12, '0')}`;
    }
  }
  return runs;
}

// --- GitHub: issues, pull requests and the loop's comments (PRD 4.3, 4.4, appendix) -------------

type IssueSpec = { number: number; title: string; phase: string | null; dependsOn: number[] };

const ISSUES: IssueSpec[] = [
  { number: 1, title: 'Serve the app with health and build id', phase: 'Skeleton', dependsOn: [] },
  { number: 2, title: 'Check branches and fixture:write', phase: 'Skeleton', dependsOn: [1] },
  { number: 3, title: 'A migrations runner that refuses main', phase: 'Skeleton', dependsOn: [1] },
  { number: 4, title: 'The design probe', phase: 'Skeleton', dependsOn: [2] },
  { number: 5, title: 'Every dashboard table', phase: 'Schema and seed', dependsOn: [3] },
  { number: 6, title: 'The comment and commit parsers', phase: 'Schema and seed', dependsOn: [5] },
  { number: 7, title: 'The seed and expected scorecard', phase: 'Schema and seed', dependsOn: [5] },
  { number: 8, title: 'The architecture parser', phase: 'Schema and seed', dependsOn: [6] },
  { number: 9, title: 'The Archon projection triggers', phase: 'Schema and seed', dependsOn: [8] },
  { number: 10, title: 'The version strip', phase: 'Screens', dependsOn: [8] },
  { number: 11, title: 'The scorecard and comparison', phase: 'Screens', dependsOn: [10] },
  { number: 12, title: 'The decisions timeline', phase: 'Screens', dependsOn: [10] },
  { number: 13, title: 'The architecture diff', phase: 'Screens', dependsOn: [9] },
  { number: 14, title: 'Phases and the issue graph', phase: 'Screens', dependsOn: [13] },
  { number: 15, title: 'Lanes and recent laps', phase: 'Screens', dependsOn: [14] },
  { number: 16, title: 'The owner queue', phase: 'Screens', dependsOn: [] },
];

/** Closed by the owner, not by a merge: issue #4 with its pull request, and #13's pull request. */
const CLOSED_BY_OWNER: Record<string, Record<number, string>> = {
  issues: { 4: '2026-10-02T12:00:00Z' },
  pulls: { 104: '2026-10-02T12:00:00Z', 113: '2026-10-11T12:00:00Z' },
};

const OWNER_ISSUE = 17;
const METRICS_ISSUE = 18;

const OWNER_BODY = `The loop needs the owner's call on these.

### Q1. Should the scorecard count paused runs as laps?
Options: A) yes, every run is a lap; B) no, only runs that finished.
Recommendation: A, so the laps a number rests on match the version strip.
If there is no answer by 2026-10-20 14:00 UTC, the loop will use A.

### Q2. Should the lanes panel show finished laps for an hour?
Options: A) yes, faded; B) no, only running laps.
Recommendation: A, so a merge that just happened is still visible.
If there is no answer by 2026-10-27 14:00 UTC, the loop will use A.

### Q3. May the merge gate merge a change to .github/workflows?
Options: A) yes, when CI passes on the change itself; B) no, the owner merges those by hand.
Recommendation: B, so a change cannot loosen the check that judges it.
If there is no answer by 2026-10-28 09:00 UTC, the loop will use B.
`;

/** When each owner question was raised, and when the answered one closed. */
const QUESTION_TIMES: Record<number, { raised: string; closed: string | null }> = {
  1: { raised: '2026-10-17T09:00:00Z', closed: '2026-10-19T10:00:00Z' },
  2: { raised: '2026-10-23T09:00:00Z', closed: null },
  3: { raised: '2026-10-24T09:00:00Z', closed: null },
};

const METRICS_BODY = `2026-10-12T09:00Z | merged since last pass: 4 (simple 1, complex 2, continue 1) | open PRs: 0 | loop send-backs since last pass: 1 | merge-gate refusals: 1 | ship correction rounds: 2 | needs-owner open: 1 | owner questions open: 0 | default branch checks: green (CI) | laps since last pass: 12 (empty 2, failed 3) | health actions: 1
2026-10-24T09:00Z | merged since last pass: 1 (simple 1, complex 0, continue 0) | open PRs: 1 | loop send-backs since last pass: 1 | merge-gate refusals: 0 | ship correction rounds: 0 | needs-owner open: 1 | owner questions open: 2 | default branch checks: green (CI) | laps since last pass: 3 (empty 0, failed 1) | health actions: 0
2026-10-24T09:00Z | holdouts at 3e4f5a6b: H-01 PASS, H-02 FAIL #14, H-04 PASS
`;

type Comment = { id: number; number: number; on: 'issues' | 'pull'; at: number };
type PullRequest = {
  issue: number;
  created: number;
  updated: number;
  head: string;
  merged: number | null;
};

const githubUrl = (on: 'issues' | 'pull', number: number) =>
  `https://github.com/${REPOSITORY}/${on}/${number}`;

function reviewText(run: Run): string | null {
  const route = run.route;
  switch (run.outcome) {
    case 'merged':
      return `Loop review: merged (route: ${route}) at ${run.head} by the merge gate, after the review above.`;
    case 'gate-refused':
      return `Loop review: not merged (route: ${route}). The merge gate refused the reviewer's merge:\n\n- ${run.spec?.refusal}\n\nThe next lap continues this pull request.`;
    case 'sent-back':
      return `Loop review: sent back (route: ${route})`;
    default:
      return null;
  }
}

/** The loop's comments: a claim per lap that claimed, its release once the lap ended, its review. */
function loopComments(runs: Run[]) {
  const comments: Comment[] = [];
  const claims: SqlRow[] = [];
  const reviews: SqlRow[] = [];
  const comment = (number: number, on: Comment['on'], at: number) => {
    const id = 900_001 + comments.length;
    comments.push({ id, number, on, at });
    return id;
  };
  for (const run of runs) {
    const claimed = run.events.find((e) => e.step === 'claim' && e.type === 'node_completed');
    if (run.issue === null || !claimed) continue;
    const claim = must(
      parseClaim(`Loop claim: run ${run.id}\nRoute: ${run.route}\nArea: ${areaOf(run.issue)}`),
      'a claim',
    );
    const claimCommentId = comment(run.issue, 'issues', claimed.at);
    const release =
      run.end === null
        ? null
        : must(
            parseClaimReleased(
              `Loop claim released: run ${run.id} ended. Its \`Loop review:\` comment, if any, says what it did.`,
            ),
            'a release',
          );
    claims.push({
      factory: FACTORY,
      issue_number: run.issue,
      run_id: claim.runId,
      route: claim.route,
      area: claim.area,
      claimed_at: iso(claimed.at),
      claim_comment_id: claimCommentId,
      released_at: release && run.end !== null ? iso(run.end) : null,
      release_comment_id:
        release && run.end !== null ? comment(run.issue, 'issues', run.end) : null,
    });
    const text = reviewText(run);
    if (text === null || run.pr === null || run.end === null) continue;
    const review = must(parseReview(text), 'a review');
    reviews.push({
      factory: FACTORY,
      comment_id: comment(run.pr, 'pull', run.end),
      pr_number: run.pr,
      outcome: review.outcome,
      route: review.route,
      sha: review.outcome === 'merged' ? review.sha : null,
      reason: review.outcome === 'refused' ? review.reason : null,
      created_at: iso(run.end),
    });
  }
  return { comments, claims, reviews };
}

/** Each pull request is opened by the first lap that builds it and carries the last one's head. */
function pullRequests(runs: Run[]): Map<number, PullRequest> {
  const prs = new Map<number, PullRequest>();
  for (const run of runs) {
    const built = run.events.find(
      (e) => (e.step === 'build' || e.step === 'ship__outcome') && e.type === 'node_completed',
    );
    if (run.pr === null || run.issue === null || !built) continue;
    const touched = run.end ?? run.events.at(-1)?.at ?? built.at;
    const pr = prs.get(run.pr) ?? {
      issue: run.issue,
      created: built.at,
      updated: touched,
      head: run.head,
      merged: null,
    };
    pr.updated = Math.max(pr.updated, touched);
    pr.head = run.head;
    if (run.outcome === 'merged') pr.merged = run.end;
    prs.set(run.pr, pr);
  }
  return prs;
}

function githubSql(runs: Run[]): string[] {
  const { comments, claims, reviews } = loopComments(runs);
  const prs = pullRequests(runs);
  const mergedAt = new Map([...prs.values()].map((pr) => [pr.issue, pr.merged]));
  const ownerClosed = (on: string, number: number) => {
    const at = CLOSED_BY_OWNER[on]?.[number];
    return at === undefined ? null : ms(at);
  };
  const lastComment = (number: number) =>
    Math.max(
      0,
      ...comments.filter((c) => c.on === 'issues' && c.number === number).map((c) => c.at),
    );

  const out = ['', '-- GitHub: issues, with phase and edges from parsePhase and parseDependsOn.'];
  const issue = (number: number, title: string, body: string, created: number) => {
    const closed = ownerClosed('issues', number) ?? mergedAt.get(number) ?? null;
    out.push(
      insert('mc.issues', {
        factory: FACTORY,
        number,
        title,
        state: closed === null ? 'open' : 'closed',
        phase: parsePhase(body),
        url: githubUrl('issues', number),
        created_at: iso(created),
        updated_at: iso(Math.max(created, closed ?? 0, lastComment(number))),
        closed_at: closed === null ? null : iso(closed),
      }),
    );
    for (const dependsOn of parseDependsOn(body)) {
      out.push(
        insert('mc.issue_dependencies', {
          factory: FACTORY,
          issue_number: number,
          depends_on: dependsOn,
        }),
      );
    }
  };
  for (const spec of ISSUES) {
    const phase = spec.phase === null ? '' : `Phase: ${spec.phase}\n\n`;
    const edges = spec.dependsOn.map((n) => `Depends on: #${n}\n`).join('');
    issue(
      spec.number,
      spec.title,
      `${phase}${spec.title}.\n\n${edges}`,
      ms('2026-09-29T10:00:00Z') + spec.number * 7 * MINUTE,
    );
  }
  issue(OWNER_ISSUE, 'Owner decisions needed', OWNER_BODY, ms('2026-09-30T09:00:00Z'));
  issue(METRICS_ISSUE, 'Loop metrics', METRICS_BODY, ms('2026-09-30T09:00:00Z'));
  out.push(insert('mc.issue_labels', { factory: FACTORY, issue_number: 13, label: 'needs-owner' }));

  out.push('', '-- GitHub: pull requests, each opened by the lap that built it.');
  for (const [number, pr] of [...prs].sort(([a], [b]) => a - b)) {
    const closed = pr.merged ?? ownerClosed('pulls', number);
    out.push(
      insert('mc.pull_requests', {
        factory: FACTORY,
        number,
        title: ISSUES.find((i) => i.number === pr.issue)?.title ?? '',
        state: closed === null ? 'open' : 'closed',
        merged_at: pr.merged === null ? null : iso(pr.merged),
        head_sha: pr.head,
        url: githubUrl('pull', number),
        created_at: iso(pr.created),
        updated_at: iso(Math.max(pr.updated, closed ?? 0)),
        closed_at: closed === null ? null : iso(closed),
      }),
      insert('mc.pull_request_issues', {
        factory: FACTORY,
        pr_number: number,
        issue_number: pr.issue,
      }),
    );
  }

  out.push(
    '',
    "-- GitHub: the loop's claim, release and review comments, through parsers/comments.ts.",
  );
  for (const c of comments) {
    out.push(
      insert('mc.comments', {
        factory: FACTORY,
        id: c.id,
        issue_number: c.number,
        author: 'coleam00',
        url: `${githubUrl(c.on, c.number)}#issuecomment-${c.id}`,
        created_at: iso(c.at),
        updated_at: iso(c.at),
      }),
    );
  }
  for (const row of claims) out.push(insert('mc.claims', row));
  for (const row of reviews) out.push(insert('mc.reviews', row));

  out.push('', `-- GitHub: #${OWNER_ISSUE}'s questions, through parseOwnerQuestions.`);
  for (const q of parseOwnerQuestions(OWNER_BODY)) {
    const times = QUESTION_TIMES[q.number];
    if (!times) throw new Error(`Q${q.number} has no times`);
    out.push(
      insert('mc.owner_questions', {
        factory: FACTORY,
        issue_number: OWNER_ISSUE,
        question_number: q.number,
        question: q.question,
        options: json(q.options),
        recommendation: q.recommendation,
        default_option: q.default,
        default_at: q.defaultAt,
        raised_at: times.raised,
        closed_at: times.closed,
      }),
    );
  }

  out.push(
    '',
    `-- GitHub: #${METRICS_ISSUE}'s lines, through parseMetricsLine and parseHoldoutsLine.`,
  );
  for (const line of METRICS_BODY.trimEnd().split('\n')) {
    const metrics = parseMetricsLine(line);
    if (metrics) {
      out.push(
        insert('mc.metrics_lines', {
          factory: FACTORY,
          at: metrics.at,
          issue_number: METRICS_ISSUE,
          merged_total: metrics.merged.total,
          merged_simple: metrics.merged.simple,
          merged_complex: metrics.merged.complex,
          merged_continue: metrics.merged.continue,
          open_prs: metrics.openPrs,
          send_backs: metrics.sendBacks,
          gate_refusals: metrics.gateRefusals,
          correction_rounds: metrics.correctionRounds,
          needs_owner_open: metrics.needsOwnerOpen,
          owner_questions_open: metrics.ownerQuestionsOpen,
          default_branch_checks: metrics.defaultBranchChecks,
          laps_total: metrics.laps.total,
          laps_empty: metrics.laps.empty,
          laps_failed: metrics.laps.failed,
          health_actions: metrics.healthActions,
        }),
      );
      continue;
    }
    const holdouts = must(parseHoldoutsLine(line), 'a Loop metrics line');
    const at = line.split(' | ')[0] ?? '';
    const report = { factory: FACTORY, at, issue_number: METRICS_ISSUE, sha: holdouts.sha };
    out.push(insert('mc.holdout_reports', report));
    for (const h of holdouts.holdouts) {
      out.push(
        `INSERT INTO mc.holdout_verdicts (report_id, scenario_id, verdict, issue_number) SELECT id, '${h.id}', '${h.verdict}', ${h.issue ?? 'NULL'} FROM mc.holdout_reports WHERE factory = '${FACTORY}' AND at = '${at}';`,
      );
    }
  }
  return out;
}

// --- The projection (PRD 11.2, 11.4, 11.7), over the seed's codebases only ----------------------

const PROJECTION = `INSERT INTO mc.laps (run_id, factory, workflow_name, status, digest, started_at, completed_at)
SELECT r.id, f.name, r.workflow_name, r.status, r.metadata->'workflow_source'->>'digest',
  r.started_at, r.completed_at
FROM remote_agent_workflow_runs r
JOIN remote_agent_codebases c ON c.id = r.codebase_id
JOIN mc.factories f ON f.codebase = c.name
WHERE r.codebase_id IN ('${SEED_CODEBASE}', '${SECOND_CODEBASE}')
ON CONFLICT DO NOTHING;

-- A step's last event decides its status and carries its timing, model, tokens, cost and output.
INSERT INTO mc.lap_steps (run_id, step_id, status, started_at, completed_at, duration_ms, provider,
  model, tokens_input, tokens_output, tokens_cache_read, tokens_cache_write, cost_usd, error, output)
SELECT DISTINCT ON (e.workflow_run_id, e.step_name)
  e.workflow_run_id, e.step_name,
  CASE e.event_type WHEN 'node_started' THEN 'running' WHEN 'node_completed' THEN 'completed'
    WHEN 'node_failed' THEN 'failed' ELSE 'skipped' END,
  (SELECT min(s.created_at) FROM remote_agent_workflow_events s
    WHERE s.workflow_run_id = e.workflow_run_id AND s.step_name = e.step_name
      AND s.event_type = 'node_started'),
  CASE WHEN e.event_type <> 'node_started' THEN e.created_at END,
  (e.data->>'duration_ms')::bigint, e.data->>'provider', e.data->>'model',
  (e.data->'tokens'->>'input')::bigint, (e.data->'tokens'->>'output')::bigint,
  (e.data->'tokens'->>'cacheRead')::bigint, (e.data->'tokens'->>'cacheWrite')::bigint,
  (e.data->>'cost_usd')::numeric, e.data->>'error',
  CASE WHEN jsonb_typeof(e.data->'structured_output') = 'object'
    THEN (e.data->'structured_output') - 'lines' END
FROM remote_agent_workflow_events e
JOIN remote_agent_workflow_runs r ON r.id = e.workflow_run_id
WHERE r.codebase_id IN ('${SEED_CODEBASE}', '${SECOND_CODEBASE}')
  AND e.event_type IN ('node_started', 'node_completed', 'node_failed', 'node_skipped')
ORDER BY e.workflow_run_id, e.step_name, e.created_at DESC, e.event_order DESC
ON CONFLICT DO NOTHING;

-- Every finished attempt of a step, through the projection's own function (the seed's events run
-- each step once, so these agree with the step rows above).
SELECT mc.record_step_attempt(e.id, e.workflow_run_id, e.event_type, e.step_name, e.data)
FROM remote_agent_workflow_events e
JOIN remote_agent_workflow_runs r ON r.id = e.workflow_run_id
WHERE r.codebase_id IN ('${SEED_CODEBASE}', '${SECOND_CODEBASE}')
  AND e.event_type IN ('node_completed', 'node_failed', 'node_skipped')
ORDER BY e.created_at, e.event_order;

-- A check-app line keeps its position, kind, verdict, evidence count, pre_existing and, for a
-- holdout, the first H-<nn> of its text (holdoutId in parsers/metrics.ts); never the text itself.
INSERT INTO mc.app_check_lines (run_id, position, kind, verdict, evidence_count, pre_existing,
  scenario_id)
SELECT e.workflow_run_id, l.position, l.line->>'kind', l.line->>'verdict',
  jsonb_array_length(l.line->'evidence'), l.line->>'pre_existing',
  CASE WHEN l.line->>'kind' = 'holdout'
    THEN coalesce(substring(l.line->>'text' from '\\mH-[0-9]{2,}\\M'), 'unidentified') END
FROM remote_agent_workflow_events e
JOIN remote_agent_workflow_runs r ON r.id = e.workflow_run_id
CROSS JOIN LATERAL jsonb_array_elements(e.data->'structured_output'->'lines')
  WITH ORDINALITY AS l(line, position)
WHERE r.codebase_id IN ('${SEED_CODEBASE}', '${SECOND_CODEBASE}')
  AND e.event_type = 'node_completed' AND e.step_name = 'check-app'
  AND jsonb_typeof(e.data->'structured_output'->'lines') = 'array'
ON CONFLICT DO NOTHING;

-- A version is a digest the factory's laps ran, labelled with the last pin before its first run.
INSERT INTO mc.versions (factory, digest, first_run_at, pin_sha)
SELECT l.factory, l.digest, min(l.started_at),
  (SELECT p.sha FROM mc.pins p WHERE p.committed_at < min(l.started_at)
    ORDER BY p.committed_at DESC LIMIT 1)
FROM mc.laps l
WHERE l.digest IS NOT NULL
GROUP BY l.factory, l.digest
ON CONFLICT DO NOTHING;`;

// --- The seed -----------------------------------------------------------------------------------

function decisionsText(versions: VersionSpec[]): string {
  const [v1, v2] = versions;
  return `# Decisions

## 2026-09-30 Fence the holdouts inside the repository
Decision: Holdout scenarios live in the repository behind a fence only the holdout verifier passes.
Why: A builder that can read the scenarios learns to pass them instead of building the product.
Replaces: holdout scenarios kept outside the repository.
Version: ${v1?.pinSha.slice(0, 8)}

## 2026-10-09 Drop the briefs step from the loop
Decision: check-app reads the holdout verifier's instructions itself; the step that copied them goes.
Why: The copy never changed a check, and every lap waited for it.
Replaces: the briefs step.
Version: ${v2?.pinSha.slice(0, 8)}

## 2026-10-15 Run three laps at once
Decision: The schedule starts a lap while two are running, never a fourth.
Why: After the first items most work depends only on the seed, not on each other.
Replaces: one lap at a time.
Version: none
`;
}

function versionsSql(versions: VersionSpec[]): string[] {
  const out = [
    '',
    '-- Pins and their verdict on coleam00/ai-software-factory, through parsePin, pinnedArchonSha and parseVerdict.',
  ];
  for (const version of versions) {
    const pin = must(parsePin(version.pinMessage), `${version.name}'s pin`);
    const pack = JSON.stringify({ integration_revision_required: version.archonSha });
    out.push(
      insert('mc.pins', {
        sha: version.pinSha,
        archon_sha: must(
          pinnedArchonSha(pin.archonSha, pack).sha ?? null,
          `${version.name}'s Archon sha`,
        ),
        reason: pin.reason,
        hypothesis: pin.hypothesis,
        measure: pin.measure,
        committed_at: version.pinnedAt,
      }),
    );
  }
  const v1Pin = versions[0]?.pinSha.slice(0, 8);
  const verdict = must(
    parseVerdict(
      `Record the verdict on ${v1Pin}\n\nVerdict: ${v1Pin} helped: complex laps took 1.4 lap-hours per merge against 2.6, over 12 laps.`,
    ),
    'the verdict',
  );
  out.push(
    insert('mc.verdicts', {
      sha: fakeSha('verdict V1'),
      pin: verdict.pin,
      verdict: verdict.verdict,
      sentence: verdict.sentence,
      committed_at: '2026-10-09T17:00:00Z',
    }),
  );

  out.push('', '-- DECISIONS.md on coleam00/ai-software-factory, through parseDecisions.');
  const decisions = parseDecisions(decisionsText(versions));
  if (decisions.errors.length > 0) throw new Error(JSON.stringify(decisions.errors));
  for (const d of decisions.entries) out.push(insert('mc.decisions', { ...d }));
  return out;
}

function archonSql(factory: FactoryEntry, runs: Run[]): string[] {
  const out = [
    '',
    "-- Archon's rows (public schema, on a check branch only): the factory's codebase, one",
    '-- archon-loop run per lap, and the events each run wrote.',
    insert('remote_agent_codebases', {
      id: SEED_CODEBASE,
      name: factory.codebase,
      repository_url: `https://github.com/${factory.repository}`,
      default_cwd: 'C:/factory/mission-control',
    }),
  ];
  for (const run of runs) {
    const target = run.issue === null ? '' : ` on #${run.issue}`;
    out.push(
      `-- ${run.label}: ${run.outcome ?? run.status}${target}`,
      insert('remote_agent_workflow_runs', {
        id: run.id,
        workflow_name: WORKFLOW,
        codebase_id: SEED_CODEBASE,
        status: run.status,
        user_message: `Run the loop on ${factory.repository}`,
        metadata: json({ workflow_source: { digest: run.version.digest } }),
        started_at: iso(run.start),
        completed_at: run.end === null ? null : iso(run.end),
        last_activity_at: iso(run.end ?? run.events.at(-1)?.at ?? run.start),
      }),
    );
    for (const event of run.events) {
      out.push(
        insert('remote_agent_workflow_events', {
          id: event.id,
          workflow_run_id: run.id,
          event_type: event.type,
          step_name: event.step,
          data: json(event.data),
          created_at: iso(event.at),
        }),
      );
    }
  }
  return out;
}

/**
 * A second factory, in the fixture only, so the factory switcher (#77) has one to switch to: its
 * own codebase and one archon-loop lap running on `claim`. Its name is no real factory's, so a
 * check branch never mixes it with one from factories.json; it runs no digest, so it adds no
 * version.
 */
export const SECOND_FACTORY: FactoryEntry = {
  name: 'second-factory',
  repository: 'coleam00/second-factory',
  codebase: 'coleam00/second-factory',
  console: 'http://localhost:3090',
};

function secondFactorySql(loop: Loop): string[] {
  const runId = '5eed0004-0000-4000-8000-000000000000';
  const startedAt = '2026-10-24T09:00:00.000Z';
  const claimedAt = '2026-10-24T09:05:00.000Z';
  return [
    '',
    '-- A second factory, for the factory switcher only: its codebase and one running lap.',
    insert('mc.factories', SECOND_FACTORY),
    insert('remote_agent_codebases', {
      id: SECOND_CODEBASE,
      name: SECOND_FACTORY.codebase,
      repository_url: `https://github.com/${SECOND_FACTORY.repository}`,
      default_cwd: 'C:/factory/second-factory',
    }),
    insert('remote_agent_workflow_runs', {
      id: runId,
      workflow_name: WORKFLOW,
      codebase_id: SECOND_CODEBASE,
      status: 'running',
      user_message: `Run the loop on ${SECOND_FACTORY.repository}`,
      metadata: json({}),
      started_at: startedAt,
      completed_at: null,
      last_activity_at: claimedAt,
    }),
    insert('remote_agent_workflow_events', {
      id: '5eedeeee-0000-4000-8000-100000000001',
      workflow_run_id: runId,
      event_type: 'node_started',
      step_name: 'claim',
      data: json({ ...block(loop, 'claim'), timing: { startedAt: claimedAt } }),
      created_at: claimedAt,
    }),
  ];
}

export function buildSeed(repoRoot: string): string {
  const { v1, v2 } = parseVersions(repoRoot);
  if (!v1.archonCommit || !v1.factoryCommit) throw new Error('the pack names no commits');
  const versions = versionSpecs(v1.archonCommit);
  // V3's pack keeps V2's loop: no architecture rows are seeded for it.
  const v2Loop = loopOf(v2);
  const runs = buildRuns(versions, { V1: loopOf(v1), V2: v2Loop, V3: v2Loop });
  const { factories } = JSON.parse(readFileSync(join(repoRoot, 'factories.json'), 'utf8')) as {
    factories: FactoryEntry[];
  };
  const factory = factories.find((f) => f.name === FACTORY);
  if (!factory) throw new Error(`factories.json has no ${FACTORY}`);
  const archKey = (archonSha: string, parsedAt: string) => ({
    archon_sha: archonSha,
    factory_sha: v1.factoryCommit ?? '',
    parsed_at: parsedAt,
  });
  const edits = V2_EDITS.flatMap((edit) => [
    `--   ${edit.file}, ${'append' in edit ? 'appended' : 'replaced'}:`,
    ...('append' in edit ? edit.append : `${edit.find}\n  with\n${edit.replace}`)
      .split('\n')
      .map((line) => `--     | ${line}`.trimEnd()),
  ]);
  return `${[
    '-- Generated by `bun run fixture:seed` (scripts/fixture/seed.ts); change the generator, not this file.',
    '-- `bun run fixture:branch` loads it onto a new check-* branch, never main (PRD 6.8).',
    '',
    '-- factories.json.',
    insert('mc.factories', factory),
    ...versionsSql(versions),
    ...archonSql(factory, runs),
    ...secondFactorySql(v2Loop),
    '',
    "-- Laps, steps, app-check lines and versions, projected from Archon's rows above.",
    PROJECTION,
    ...githubSql(runs),
    '',
    '-- Architecture: V1 is parsers/pack.ts on fixtures/pack/ and fixtures/factory-template/; V2 is',
    '-- the same with one step removed, one added, one prompt and one subagent changed:',
    ...edits,
    ...architectureSql(
      { version: v1, key: archKey(v1.archonCommit, '2026-10-01T00:00:00Z') },
      { version: v2, key: archKey(V2_ARCHON, '2026-10-10T00:00:00Z') },
    ),
    '',
    '-- A rewind `bun run rewind:create` registered. No Neon branch has its name: switching to it',
    '-- answers 404.',
    insert('mc.rewind_branches', {
      name: 'rewind-2026-10-24t11-00-00z',
      parent: 'main',
      at: '2026-10-24T11:00:00Z',
      created_at: '2026-10-24T11:02:00Z',
    }),
  ].join('\n')}\n`;
}

/** A PGlite database holding Archon's schema snapshot, the migrations and `seed`. */
export async function seededDb(repoRoot: string, seed: string): Promise<Db> {
  const db = pgliteDb(new PGlite());
  await db.query(readFileSync(join(repoRoot, 'fixtures', 'archon-schema.sql'), 'utf8'));
  await runMigrations({ files: readMigrationFiles(migrationsDir(repoRoot)), db });
  await db.transaction((tx) => tx.query(seed).then(() => undefined));
  return db;
}

export const main: Main = async (argv, deps) =>
  noArguments(argv, USAGE, deps) ??
  failing(deps, async () => {
    const seed = buildSeed(deps.repoRoot);
    writeFileSync(join(deps.repoRoot, 'fixtures', 'seed.sql'), seed);
    deps.out('wrote fixtures/seed.sql');
    const db = await seededDb(deps.repoRoot, seed);
    try {
      const value = await scorecard(db, deps.repoRoot);
      writeFileSync(
        join(deps.repoRoot, 'fixtures', 'expected-scorecard.json'),
        `${JSON.stringify(value, null, 2)}\n`,
      );
      deps.out('wrote fixtures/expected-scorecard.json');
    } finally {
      await db.close();
    }
  });

if (import.meta.main) await runCli(main);
