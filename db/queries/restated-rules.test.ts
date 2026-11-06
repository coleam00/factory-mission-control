import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { COLUMNS, parked } from '../../app/lib/board';
import { LAP_PAGE_WORKFLOW } from '../../app/lib/one-lap';
import { REVIEW_TONE } from '../../app/lib/review-outcome';
import {
  QUEUE_ENDING,
  QUEUE_REVIEW,
  ROUTE_OF_LABEL,
  WORK_ITEM_NUMBER,
} from '../../app/lib/work-item';
import { runMigrations } from '../../scripts/migrate';
import { archonDb, migrationFiles } from '../test-db';
import { onTheSeed, queries } from './test-seed';

const root = join(import.meta.dir, '..', '..');
const read = (...path: string[]) => readFileSync(join(root, ...path), 'utf8');
const sqlOf = (name: string) => queries.find(([n]) => n === name)?.[1] as string;
const quoted = (text: string) => [...text.matchAll(/'([^']*)'/g)].map((m) => m[1] as string);
// A computed path keeps tsc out of the pack, whose `.ts` import extensions this config refuses.
const pack = (...path: string[]) => import(join(root, 'fixtures', 'pack', ...path));

test('the health queries exclude exactly the pack manager titles', async () => {
  const { MANAGER_TITLES } = await pack('sdlc', '.shared', 'workable.ts');
  const expected = [...MANAGER_TITLES].sort();

  const notIn = sqlOf('health-workable').match(/i\.title NOT IN \(([^)]*)\)/);
  expect(notIn).not.toBeNull();
  expect(quoted(notIn?.[1] ?? '').sort()).toEqual(expected);
});

test('the board route CASE agrees with the pack ROUTE_LABEL', async () => {
  const { ROUTE_LABEL } = await pack('queue', 'sdlc', '.shared', 'labels.ts');
  const block = sqlOf('board').match(/CASE lb\.label([\s\S]*?)END\) AS route/);
  expect(block).not.toBeNull();
  const pairs = [...(block?.[1] ?? '').matchAll(/WHEN '([^']*)' THEN '([^']*)'/g)].map(
    (m) => [m[1], m[2]] as const,
  );
  expect(new Set(pairs.map(([label]) => label))).toEqual(new Set(Object.values(ROUTE_LABEL)));
  for (const [label, route] of pairs) expect(ROUTE_LABEL[route as string]).toBe(label);
});

test('the Board grid has one track per column', () => {
  expect(read('app', 'components', 'Board.tsx')).toContain(
    `grid-cols-[repeat(${COLUMNS.length},minmax(`,
  );
});

test('map-right-now reads only paths the pinned merge queue declares', () => {
  const sql = sqlOf('map-right-now');
  const gate = sql.slice(0, sql.indexOf(') gate'));
  const joins = [
    ...gate.matchAll(
      /JOIN mc\.lap_steps (\w+) ON \1\.run_id = l\.run_id AND \1\.step_id = '([\w-]+)'/g,
    ),
  ];
  const steps = Object.fromEntries(joins.map((m) => [m[1], m[2]] as const));
  expect(steps).toEqual({ rec: 'record', fa: 'facts', sw: 'sweep' });
  // A read or join this parser cannot spell, or whose path continues past what it parsed,
  // would otherwise be skipped unchecked.
  expect(joins.length).toBe(gate.split('mc.lap_steps').length - 1);

  const reads = [...gate.matchAll(/\b(rec|fa|sw)\.output((?: ->>? '[\w]+')+)(?!\s*(?:->|#>|\[))/g)];
  expect(reads.length).toBe(gate.split(/\.output\b/).length - 1);
  const paths = new Set(
    reads.map(
      (m) =>
        `${steps[m[1] as string]}${[...(m[2] as string).matchAll(/'(\w+)'/g)].map((k) => `.${k[1]}`).join('')}`,
    ),
  );
  expect([...paths].sort()).toEqual([
    'facts.items',
    'record.asked.pr.number',
    'record.merged',
    'sweep.decisions',
  ]);

  const yaml = Bun.YAML.parse(
    read('fixtures', 'pack', 'queue', 'sdlc', 'merge-queue', 'archon-merge-queue.yaml'),
  ) as { nodes: { id: string; output_format?: { properties?: Record<string, unknown> } }[] };
  const mergeTs = read('fixtures', 'pack', 'queue', 'sdlc', '.shared', 'merge.ts');
  const forgeTs = read('fixtures', 'pack', 'queue', 'sdlc', '.shared', 'forge.ts');

  for (const path of paths) {
    const [step, ...keys] = path.split('.') as [string, ...string[]];
    const node = yaml.nodes.find((n) => n.id === step);
    expect(node?.output_format, `${step} declares an output_format`).toBeDefined();
    let at = node?.output_format as { properties?: Record<string, unknown> };
    const walked: string[] = [];
    for (const [i, key] of keys.entries()) {
      if (at.properties === undefined) {
        // The yaml leaves `record.asked` open; the pinned TypeScript is its only declaration.
        expect(path).toBe('record.asked.pr.number');
        expect(keys.slice(i)).toEqual(['pr', 'number']);
        expect(mergeTs).toMatch(
          /by: Extract<MergeAskedBy, 'pr'>;\s*readonly item: QualifiedPr;\s*readonly pr: QualifiedPr;/,
        );
        expect(forgeTs).toMatch(
          /export interface QualifiedPr \{\s*readonly repo:[^\n]*\n\s*readonly number: number;/,
        );
        break;
      }
      walked.push(key);
      expect(Object.keys(at.properties), `${step}.${walked.join('.')} is declared`).toContain(key);
      at = at.properties[key] as { properties?: Record<string, unknown> };
    }
  }
});

test('the queries behind a link to the lap page filter on LAP_PAGE_WORKFLOW', () => {
  const archonLiterals = (name: string) =>
    [...sqlOf(name).matchAll(/'(archon-[a-z-]+)'/g)].map((m) => m[1]);
  for (const name of ['recent-laps']) {
    expect([
      name,
      [...sqlOf(name).matchAll(/workflow_name = '([^']*)'/g)].map((m) => m[1]),
    ]).toEqual([name, [LAP_PAGE_WORKFLOW]]);
    expect([name, archonLiterals(name)]).toEqual([name, [LAP_PAGE_WORKFLOW]]);
  }
});

test('the Board’s parked rule agrees with the pickups of the pinned build and merge queues', async () => {
  const { buildWaits, LAUNCH_STAGES } = await pack('queue', 'sdlc', '.shared', 'build.ts');
  const { mergeWaits } = await pack('queue', 'sdlc', '.shared', 'merge.ts');
  const hour = (h: number) => `2026-11-05T${String(h).padStart(2, '0')}:00:00.000Z`;
  const doc = (stage: string, facts: object) => ({
    version: 1,
    subject: { repo: { host: 'github.com', path: 'o/r' }, number: 1 },
    stage,
    claim: null,
    requests: [],
    facts,
    history: [],
  });
  const triage = (h: number) => ({
    at: hour(h),
    run_id: 'x',
    verdict: { contract: 'READY', route: 'deliver' },
  });
  const build = (status: string, h: number) => ({
    status,
    at: hour(h),
    brief: '',
    rounds: [],
    decisions: [],
  });
  const merge = (status: string, h: number) => ({
    status,
    at: hour(h),
    pr: null,
    approval: null,
    decisions: [],
  });
  const ownPr = (h: number) => ({ url: 'https://github.com/o/r/pull/1', at: hour(h) });
  const docs = [
    doc('deliver', { triage: triage(1), build: build('parked', 2) }),
    doc('deliver', { triage: triage(3), build: build('parked', 2) }),
    doc('blocked', { triage: triage(3), build: build('parked', 2) }),
    doc('deliver', { triage: triage(1), build: build('next', 2) }),
    doc('deliver', { triage: triage(1), build: build('asking', 2) }),
    doc('deliver', { triage: triage(1), merge: merge('returned', 2), build: build('parked', 3) }),
    doc('deliver', { triage: triage(1), build: build('ready', 2), merge: merge('parked', 3) }),
    doc('deliver', { triage: triage(1), build: build('ready', 4), merge: merge('parked', 3) }),
    doc('deliver', { triage: triage(5), build: build('ready', 2), merge: merge('parked', 3) }),
    doc('deliver', { triage: triage(1), build: build('ready', 2), merge: merge('waiting', 3) }),
    doc('merge', { own_pr: ownPr(1), merge: merge('parked', 2) }),
    doc('merge', { own_pr: ownPr(3), merge: merge('parked', 2) }),
    doc('merge', { own_pr: ownPr(1), merge: merge('waiting', 2) }),
    doc('deliver', { build: build('asking', 1), own_pr: ownPr(3), merge: merge('parked', 2) }),
  ];
  const db = await archonDb();
  try {
    await runMigrations({ files: migrationFiles, db });
    for (const [i, d] of docs.entries()) {
      await db.query(
        `INSERT INTO public.remote_agent_state_revisions (project_key, name, revision, value, operation, writer_kind)
         VALUES ('o/r', $1, 1, $2, 'put', 'run')`,
        [`work/${i + 1}`, JSON.stringify(d)],
      );
    }
    for (const [i, d] of docs.entries()) {
      const [row] = await db.query(
        `SELECT build_status, build_at, merge_status, merge_at, triage_at, own_pr_at
         FROM mc.work_item_states WHERE number = $1`,
        [i + 1],
      );
      const state = row as unknown as Parameters<typeof parked>[0];
      const f = d.facts as Record<string, { status?: string; at: string } | undefined>;
      const parkedAt =
        f.build?.status === 'parked'
          ? f.build.at
          : f.merge?.status === 'parked'
            ? f.merge.at
            : null;
      const triagedAt = f.triage?.at ?? null;
      const retriaged =
        !(LAUNCH_STAGES as readonly string[]).includes(d.stage) &&
        triagedAt !== null &&
        parkedAt !== null &&
        triagedAt > parkedAt;
      const expected = !retriaged && parkedAt !== null && !buildWaits(d) && !mergeWaits(d);
      expect(parked(state), JSON.stringify(d.facts)).toBe(expected);
    }
  } finally {
    await db.close();
  }
});

const yamlEnum = (file: string[], node: string, key: string): string[] => {
  const doc = Bun.YAML.parse(read('fixtures', 'pack', ...file)) as {
    nodes: { id: string; output_format?: { properties?: Record<string, { enum?: string[] }> } }[];
  };
  const values = doc.nodes.find((n) => n.id === node)?.output_format?.properties?.[key]?.enum;
  expect(values, `${file.join('/')} ${node}.${key} declares an enum`).toBeDefined();
  return values as string[];
};

test('the work item page reads the pack route labels', async () => {
  const { ROUTE_LABEL } = await pack('queue', 'sdlc', '.shared', 'labels.ts');
  // `continue` shares `deliver`'s label, which the Board and the page both read as deliver.
  const { continue: _continue, ...routes } = ROUTE_LABEL;
  expect(ROUTE_OF_LABEL).toEqual(
    Object.fromEntries(Object.entries(routes).map(([route, label]) => [label, route])),
  );
});

test('the work item page words every build-queue ending, or the pack leaves it unworded on purpose', () => {
  const decisions = yamlEnum(
    ['queue', 'sdlc', 'build-queue', 'archon-build-queue.yaml'],
    'apply',
    'decision',
  );
  const unworded = decisions.filter((d) => !(d in QUEUE_ENDING));
  // `idle` and `launch` end no delivery round: a new decision fails here until it is worded or listed.
  expect(unworded.sort()).toEqual(['idle', 'launch']);
  expect(Object.keys(QUEUE_ENDING).every((d) => decisions.includes(d))).toBe(true);
});

test('the work item page words exactly the build-queue review actions', () => {
  const actions = yamlEnum(
    ['queue', 'sdlc', 'review', 'archon-review-block.yaml'],
    'synthesize',
    'action',
  );
  expect(Object.keys(QUEUE_REVIEW).sort()).toEqual([...actions].sort());
});

test('the old loop review outcomes the page words are the archon-loop enum', () => {
  const outcomes = yamlEnum(['sdlc', 'loop', 'archon-loop.yaml'], 'review', 'outcome');
  expect(Object.keys(REVIEW_TONE).sort()).toEqual([...outcomes].sort());
});

test('the work item page renders exactly the pack sweep actions', async () => {
  const { SWEEP_ACTIONS } = await pack('queue', 'sdlc', '.shared', 'merge.ts');
  const body = read('app', 'lib', 'work-item.ts');
  const cases = [
    ...body.slice(body.indexOf('function sweepDecision')).matchAll(/case '([^']*)':/g),
  ];
  expect(cases.map((m) => m[1]).sort()).toEqual([...SWEEP_ACTIONS].sort());
});

test('the work item address guard accepts the numbers mc.run_issue_number reads', async () => {
  const db = await onTheSeed();
  try {
    for (const n of ['0', '1', '123', '999999999', '1000000000', '01', '-1', '1a', '']) {
      const [row] = await db.query(
        `SELECT mc.run_issue_number(jsonb_build_object('inputs', jsonb_build_object('number', $1::text))) AS n`,
        [n],
      );
      expect([n, WORK_ITEM_NUMBER.test(n)]).toEqual([n, row?.n !== null]);
    }
  } finally {
    await db.close();
  }
}, 60_000);
