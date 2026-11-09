import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BLOCKED_STAGES,
  FOUND_OUTCOMES,
  PARKED,
  parked,
  SPLIT_WORKFLOW,
} from '../../app/lib/board';
import { STOP_CLASSES } from '../../app/lib/failures';
import { causeOf } from '../../app/lib/health';
import { LAP_PAGE_WORKFLOW, prNumber } from '../../app/lib/one-lap';
import { QUEUE_ENDING_STATE, QUEUE_REVIEW_STATE, REVIEW_OUTCOME_STATE } from '../../app/lib/states';
import { ROUTE_OF_LABEL, WORK_ITEM_NUMBER } from '../../app/lib/work-item';
import { runMigrations } from '../../scripts/migrate';
import { STOP_CORPUS } from '../run-stops-corpus';
import { archonDb, migrationFiles } from '../test-db';
import { migratedDb, onTheSeed, queries } from './test-seed';

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

test('health-workable.sql excludes the workflows board.ts says hold no work item', () => {
  expect(
    [...sqlOf('health-workable').matchAll(/workflow_name <> '([^']*)'/g)].map((m) => m[1]),
  ).toEqual([SPLIT_WORKFLOW]);
});

test('mc.pr_number reads a step pr as prNumber does, a JSON object included', async () => {
  const pull = (n: number) => `https://github.com/o/r/pull/${n}`;
  const cases: unknown[] = [
    '#103',
    '103',
    ' 103 ',
    pull(103),
    `${pull(103)}/`,
    'https://github.com/o/r/issues/103',
    'see PR 103',
    '',
    '#0',
    '#999999999999999999999999999',
    { number: 103 },
    { number: 103, url: pull(9) },
    { url: pull(9) },
    { number: 1.5, url: pull(9) },
    { number: -3, url: pull(4) },
    { url: 'https://github.com/o/r/issues/9' },
    {},
    [103],
    103,
    '{"number": 7}',
    '{not json',
  ];
  const db = await migratedDb();
  try {
    for (const [i, pr] of cases.entries()) {
      const run = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
      await db.query(
        `INSERT INTO mc.lap_steps (run_id, step_id, status, output)
         VALUES ($1, 'check-app', 'completed', $2)`,
        [run, JSON.stringify({ pr })],
      );
      const [row] = await db.query(
        `SELECT output ->> 'pr' AS text, pr_number FROM mc.lap_steps WHERE run_id = $1`,
        [run],
      );
      const expected = prNumber(row?.text as string);
      // A number past integer has no pull request, so the column reads NULL where the rule returns it.
      const fits = expected !== null && expected <= 2147483647;
      expect(row?.pr_number, JSON.stringify(pr)).toBe(fits ? expected : null);
    }
    await db.query(
      `UPDATE mc.lap_steps SET output = '{"pr":"#7"}' WHERE run_id = '00000000-0000-4000-8000-000000000000'`,
    );
    const [moved] = await db.query(
      `SELECT pr_number FROM mc.lap_steps WHERE run_id = '00000000-0000-4000-8000-000000000000'`,
    );
    expect(moved?.pr_number).toBe(7);
  } finally {
    await db.close();
  }
}, 60_000);

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
    doc('deliver', { triage: triage(1), build: build(PARKED, 2) }),
    doc('deliver', { triage: triage(3), build: build(PARKED, 2) }),
    doc('blocked', { triage: triage(3), build: build(PARKED, 2) }),
    doc('deliver', { triage: triage(1), build: build('next', 2) }),
    doc('deliver', { triage: triage(1), build: build('asking', 2) }),
    doc('deliver', { triage: triage(1), merge: merge('returned', 2), build: build(PARKED, 3) }),
    doc('deliver', { triage: triage(1), build: build('ready', 2), merge: merge(PARKED, 3) }),
    doc('deliver', { triage: triage(1), build: build('ready', 4), merge: merge(PARKED, 3) }),
    doc('deliver', { triage: triage(5), build: build('ready', 2), merge: merge(PARKED, 3) }),
    doc('deliver', { triage: triage(1), build: build('ready', 2), merge: merge('waiting', 3) }),
    doc('merge', { own_pr: ownPr(1), merge: merge(PARKED, 2) }),
    doc('merge', { own_pr: ownPr(3), merge: merge(PARKED, 2) }),
    doc('merge', { own_pr: ownPr(1), merge: merge('waiting', 2) }),
    doc('deliver', { build: build('asking', 1), own_pr: ownPr(3), merge: merge(PARKED, 2) }),
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
    await db.query(
      `INSERT INTO mc.factories (name, repository, codebase, console) VALUES ('f', 'o/r', 'o/r', 'c')`,
    );
    for (const n of [...docs.keys()].map((i) => i + 1).concat(99)) {
      await db.query(
        `INSERT INTO mc.issues (factory, number, title, state, url, created_at, updated_at)
         VALUES ('f', $1, 't', 'open', 'u', now(), now())`,
        [n],
      );
    }
    const workable = new Set(
      (await db.query(sqlOf('health-workable'), ['f'])).flatMap((r) =>
        r.kind === 'issue' ? [r.issue_number as number] : [],
      ),
    );
    expect(workable.has(99), 'an issue with no work item state stays workable').toBe(true);
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
      expect(!workable.has(i + 1), JSON.stringify(d.facts)).toBe(expected);
    }
  } finally {
    await db.close();
  }
});

const statusUnion = (file: string, name: string) => {
  const match = read('fixtures', 'pack', 'queue', 'sdlc', '.shared', file).match(
    new RegExp(`export type ${name} =([^;]*);`),
  );
  expect(match, `${file} declares ${name}`).not.toBeNull();
  return quoted(match?.[1] ?? '');
};

test('the parked status is the pinned pack’s, in parked() and in health-workable', () => {
  const statuses = {
    build: statusUnion('build.ts', 'BuildStatus'),
    merge: statusUnion('merge.ts', 'MergeStatus'),
  };
  expect(statuses.build).toContain(PARKED);
  expect(statuses.merge).toContain(PARKED);
  const literals = [
    ...sqlOf('health-workable').matchAll(/(build|merge)_status (?:=|IS DISTINCT FROM) '([^']*)'/g),
  ];
  expect(literals.length).toBeGreaterThan(0);
  for (const [, queue, status] of literals) {
    expect(statuses[queue as 'build' | 'merge'], `${queue}_status '${status}'`).toContain(status);
  }
  expect(new Set(literals.map((l) => l[2]).filter((s) => s !== 'ready'))).toEqual(
    new Set([PARKED]),
  );
});

const PARKED_RULE = /w\.build_status = 'parked'[\s\S]*?w\.merge_at, false\)\)/;
const squashed = (text: string) => text.replace(/\s+/g, ' ').trim();

test('the Unstick parked rule is health-workable’s, verbatim', () => {
  const rule = (name: string) => PARKED_RULE.exec(sqlOf(name))?.[0] ?? '';
  expect(rule('health-workable')).not.toBe('');
  expect(squashed(rule('unstick'))).toBe(squashed(rule('health-workable')));
});

test('a claim is stale in Unstick for exactly the run statuses the pinned pack releases', async () => {
  const { claimDisposition } = await pack('queue', 'sdlc', '.shared', 'state.ts');
  const released = ['pending', 'running', 'paused', 'completed', 'failed', 'cancelled'].filter(
    (status) => claimDisposition(status) === 'release',
  );
  const list = /l\.status IN \(([^)]*)\)/.exec(sqlOf('unstick'))?.[1] ?? '';
  expect(quoted(list).sort()).toEqual(released.sort());
});

test('the projected item number reads the titles the pinned queues render', () => {
  const migration = read('db', 'migrations', '0031_attention_data.sql');
  expect(migration).toContain('(?:issue|PR) ([1-9][0-9]{0,8}):');
  expect(read('fixtures/pack/queue/sdlc/build-queue/scripts/apply.ts')).toContain(
    'Build queue, issue ${String(item.number)}: ',
  );
  expect(read('fixtures/pack/queue/sdlc/merge-queue/scripts/record.ts')).toContain(
    'Merge queue, PR ${String(raised.pr.number)}: ',
  );
});

test('the stages Unstick reads are the pinned pack’s', () => {
  const stages = statusUnion('workitem.ts', 'Stage');
  const literals = [...sqlOf('unstick').matchAll(/w\.stage = '([^']*)'/g)].map((m) => m[1]);
  expect(literals.length).toBeGreaterThan(0);
  for (const stage of literals) expect(stages, `stage '${stage}'`).toContain(stage);
});

test('the stages the Board calls blocked are the pinned pack’s', () => {
  const stages = statusUnion('workitem.ts', 'Stage');
  for (const stage of BLOCKED_STAGES) expect(stages, `stage '${stage}'`).toContain(stage);
});

test('the Found card reads the pack’s discoveries outcome', () => {
  const doc = Bun.YAML.parse(
    read('fixtures', 'pack', 'queue', 'sdlc', 'discoveries', 'archon-discoveries.yaml'),
  ) as {
    nodes: {
      id: string;
      output_format?: {
        properties?: Record<
          string,
          { items?: { properties?: Record<string, { enum?: string[] }> } }
        >;
      };
    }[];
  };
  const properties = doc.nodes.find((n) => n.id === 'outcome')?.output_format?.properties;
  expect(properties?.dropped).toBeDefined();
  expect(properties?.written?.items?.properties?.outcome?.enum).toEqual([...FOUND_OUTCOMES]);
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
  const unworded = decisions.filter((d) => !(d in QUEUE_ENDING_STATE));
  // `idle` and `launch` end no delivery round: a new decision fails here until it is worded or listed.
  expect(unworded.sort()).toEqual(['idle', 'launch']);
  expect(Object.keys(QUEUE_ENDING_STATE).every((d) => decisions.includes(d))).toBe(true);
});

test('the work item page words exactly the build-queue review actions', () => {
  const actions = yamlEnum(
    ['queue', 'sdlc', 'review', 'archon-review-block.yaml'],
    'synthesize',
    'action',
  );
  expect(Object.keys(QUEUE_REVIEW_STATE).sort()).toEqual([...actions].sort());
});

test('the old loop review outcomes the page words are the archon-loop enum', () => {
  const outcomes = yamlEnum(['sdlc', 'loop', 'archon-loop.yaml'], 'review', 'outcome');
  expect(Object.keys(REVIEW_OUTCOME_STATE).sort()).toEqual([...outcomes].sort());
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

test('lanes, home-map and health-workable resolve the same item for every source of it', async () => {
  const db = await migratedDb();
  try {
    await db.query(
      `INSERT INTO mc.factories (name, repository, codebase, console) VALUES ('f', 'o/r', 'o/r', 'c')`,
    );
    for (let n = 1; n <= 8; n++) {
      await db.query(
        `INSERT INTO mc.issues (factory, number, title, state, url, created_at, updated_at)
         VALUES ('f', $1, $2, 'open', 'u', now(), now())`,
        [n, `t${n}`],
      );
    }
    const id = (c: string) => `5eed0000-0000-4000-8000-00000000000${c}`;
    // claim, facts item, number input; null for a source the run does not have
    const runs = {
      '1': { status: 'running', claim: 1, facts: null, input: null },
      '2': { status: 'running', claim: null, facts: 2, input: null },
      '3': { status: 'running', claim: null, facts: null, input: 3 },
      '4': { status: 'running', claim: 4, facts: 5, input: 6 },
      '5': { status: 'running', claim: null, facts: 5, input: 6 },
      '6': { status: 'running', claim: null, facts: null, input: null },
      '7': { status: 'completed', claim: null, facts: 7, input: null },
      '8': { status: 'running', claim: null, facts: 8, input: null, workflow: SPLIT_WORKFLOW },
    } as const;
    for (const [c, r] of Object.entries(runs)) {
      await db.query(
        `INSERT INTO mc.laps (run_id, factory, workflow_name, status, started_at, issue_number)
         VALUES ($1, 'f', $4, $2, now(), $3)`,
        [id(c), r.status, r.input, 'workflow' in r ? r.workflow : 'w'],
      );
      if (r.facts !== null) {
        await db.query(
          `INSERT INTO mc.lap_steps (run_id, step_id, status, started_at, output)
           VALUES ($1, 'facts', 'completed', now(), $2)`,
          [id(c), JSON.stringify({ item: { number: r.facts } })],
        );
      }
      if (r.claim !== null) {
        // Released, so the held-by-a-run clause, not the unreleased-claim clause, is what holds it.
        await db.query(
          `INSERT INTO mc.claims (factory, issue_number, run_id, claimed_at, released_at)
           VALUES ('f', $1, $2, now(), now())`,
          [r.claim, id(c)],
        );
      }
    }
    const held = (rows: Record<string, unknown>[]) =>
      Object.fromEntries(rows.map((r) => [r.run_id as string, r.issue_number ?? r.number ?? null]));
    const expected = {
      [id('1')]: 1,
      [id('2')]: 2,
      [id('3')]: 3,
      [id('4')]: 4,
      [id('5')]: 5,
      [id('6')]: null,
      [id('8')]: 8,
    };
    // Each issue is titled by its own number, so a title join that drops a source or reorders precedence differs from the held item.
    const titled = (rows: Record<string, unknown>[], col: string) =>
      Object.fromEntries(rows.map((r) => [r.run_id as string, r[col] ?? null]));
    const expectedTitles = Object.fromEntries(
      Object.entries(expected).map(([k, v]) => [k, v === null ? null : `t${v}`]),
    );
    const lanes = await db.query(sqlOf('lanes'), ['f']);
    const laps = (await db.query(sqlOf('home-map'), ['f', ''])).filter((r) => r.kind === 'lap');
    expect(held(lanes)).toEqual(expected);
    expect(held(laps)).toEqual(expected);
    expect(titled(lanes, 'issue_title')).toEqual(expectedTitles);
    expect(titled(laps, 'title')).toEqual(expectedTitles);
    const workable = (await db.query(sqlOf('health-workable'), ['f']))
      .flatMap((r) => (r.kind === 'issue' ? [r.issue_number as number] : []))
      .sort();
    // A split run shows its item on Laps and the map, but holds nothing: 8 stays workable.
    expect(workable).toEqual([6, 7, 8]);
  } finally {
    await db.close();
  }
});

test('board rounds count a shipped run on the item every other screen holds', async () => {
  const db = await migratedDb();
  try {
    await db.query(
      `INSERT INTO mc.factories (name, repository, codebase, console) VALUES ('f', 'o/r', 'o/r', 'c')`,
    );
    for (let n = 1; n <= 8; n++) {
      await db.query(
        `INSERT INTO mc.issues (factory, number, title, state, url, created_at, updated_at)
         VALUES ('f', $1, $2, 'open', 'u', now(), now())`,
        [n, `t${n}`],
      );
    }
    const id = (c: number) => `5eed0000-0000-4000-8000-00000000000${c}`;
    // claim, facts item, number input, and whether the run reached ship
    const runs = [
      { claim: 1, facts: null, input: null, ship: true },
      { claim: null, facts: 2, input: null, ship: true },
      { claim: null, facts: null, input: 3, ship: true },
      { claim: 4, facts: 5, input: 6, ship: true },
      { claim: null, facts: 5, input: 6, ship: true },
      { claim: 1, facts: null, input: null, ship: false },
      { claim: 2, facts: null, input: null, ship: true, workflow: 'other' },
      // Holds two issues: the newest claim (8) is where every screen holds it, not the older 7.
      { claim: null, facts: null, input: null, ship: true },
    ];
    for (const [k, r] of runs.entries()) {
      const c = k + 1;
      await db.query(
        `INSERT INTO mc.laps (run_id, factory, workflow_name, status, started_at, issue_number)
         VALUES ($1, 'f', $2, 'running', now(), $3)`,
        [id(c), r.workflow ?? 'archon-build-queue', r.input],
      );
      if (r.facts !== null) {
        await db.query(
          `INSERT INTO mc.lap_steps (run_id, step_id, status, started_at, output)
           VALUES ($1, 'facts', 'completed', now(), $2)`,
          [id(c), JSON.stringify({ item: { number: r.facts } })],
        );
      }
      if (r.ship) {
        await db.query(
          `INSERT INTO mc.lap_steps (run_id, step_id, status, started_at) VALUES ($1, 'ship', 'completed', now())`,
          [id(c)],
        );
      }
      if (r.claim !== null) {
        await db.query(
          `INSERT INTO mc.claims (factory, issue_number, run_id, claimed_at, released_at)
           VALUES ('f', $1, $2, now(), now())`,
          [r.claim, id(c)],
        );
      }
    }
    for (const [n, age] of [
      [7, '2 hours'],
      [8, '1 hour'],
    ] as const) {
      await db.query(
        `INSERT INTO mc.claims (factory, issue_number, run_id, claimed_at, released_at)
         VALUES ('f', $1, $2, now() - $3::interval, now())`,
        [n, id(8), age],
      );
    }
    const rounds = Object.fromEntries(
      (await db.query(sqlOf('board'), ['f']))
        .filter((r) => r.number !== null)
        .map((r) => [r.number as number, r.rounds]),
    );
    // The owner's answer: lanes.sql holds each (running) run on an item; a shipped loop/queue run is a round there.
    const owned: Record<number, number> = {};
    for (const row of await db.query(sqlOf('lanes'), ['f'])) {
      const run = runs[Number(String(row.run_id).slice(-1)) - 1];
      if (run?.ship && run.workflow === undefined && row.issue_number !== null) {
        const n = row.issue_number as number;
        owned[n] = (owned[n] ?? 0) + 1;
      }
    }
    const expected = Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8].map((n) => [n, owned[n] ?? 0]));
    expect(rounds).toEqual(expected);
    expect(Object.values(expected).reduce((a, b) => a + b, 0)).toBe(6);
  } finally {
    await db.close();
  }
}, 60_000);

test('mc.stop_class refines Health’s causes, agreeing with causeOf on every corpus line', async () => {
  // 0032 replaced mc.project_run_stop, so its failed-step pick is the one Postgres runs.
  const sql = read('db', 'migrations', '0032_stop_line.sql');
  // All three read "the run's latest failed step": the whole WHERE (bar the run-id correlation) and the
  // ORDER BY, copied because a live query cannot call the mc function. A pick whose WHERE is not exactly
  // `run_id = ... AND status = 'failed'` matches nothing and fails the test.
  const failedStepPick = (text: string, alias: string) =>
    text
      .match(/WHERE (\w+)\.run_id = [\w.]+ AND \1\.status = 'failed'\s+ORDER BY[^;]*?LIMIT 1/g)
      ?.find((pick) => pick.startsWith(`WHERE ${alias}.`))
      ?.replace(/run_id = [\w.]+/, 'run_id = RUN')
      .replaceAll(`${alias}.`, '')
      .replace(/\s+/g, ' ');
  const picks = [
    failedStepPick(sql, 's'),
    failedStepPick(read('db', 'queries', 'health-runs.sql'), 'ls'),
    failedStepPick(read('db', 'queries', 'work-item.sql'), 'ls'),
  ];
  expect(picks[0]).toBeDefined();
  expect(picks[1]).toBe(picks[0]);
  expect(picks[2]).toBe(picks[0]);
  const db = await migratedDb();
  try {
    const seen = new Set<string>();
    for (const line of STOP_CORPUS.map(([l]) => l)) {
      const cause = causeOf(line);
      if (cause === 'other') continue;
      seen.add(cause);
      const [row] = await db.query('SELECT mc.stop_class($1) AS class', [line]);
      expect(row?.class).toBe(cause === 'authentication' ? 'config' : 'transient');
    }
    expect(seen).toEqual(new Set(['usage-limit', 'authentication', 'infrastructure']));

    // Emoji are two UTF-16 units but one character: the cut must fall on characters, as left() does.
    for (const filler of ['x', '😀']) {
      const near = `${filler.repeat(7990)} HTTP 429`;
      const past = `${filler.repeat(8000)} HTTP 429`;
      expect(causeOf(near)).toBe('usage-limit');
      expect((await db.query('SELECT mc.stop_class($1) AS class', [near]))[0]?.class).toBe(
        'transient',
      );
      expect(causeOf(past)).toBe('other');
      expect((await db.query('SELECT mc.stop_class($1) AS class', [past]))[0]?.class).toBeNull();
    }
  } finally {
    await db.close();
  }
});

test('the run-stop migration writes only classes and stopped statuses its CHECKs allow', () => {
  // The class function and the table CHECK live in 0031; 0032 replaced the projector, so its guard is read there.
  const sql = read('db', 'migrations', '0031_run_stops.sql');
  const guardSql = read('db', 'migrations', '0032_stop_line.sql');
  const classFn = sql.match(/FUNCTION mc\.stop_class[\s\S]*?\$\$;/)?.[0] ?? '';
  const thens = [...classFn.matchAll(/THEN '([^']*)'/g)].map((m) => m[1] as string);
  expect(thens.length).toBeGreaterThan(0);
  expect([...new Set(thens)].sort()).toEqual([...STOP_CLASSES].sort());

  const checked = quoted(
    sql.match(/status text NOT NULL CHECK \(status IN \(([^)]*)\)/)?.[1] ?? '',
  );
  const guard = quoted(guardSql.match(/l\.status NOT IN \(([^)]*)\)/)?.[1] ?? '');
  expect(checked.length).toBeGreaterThan(0);
  expect(guard.sort()).toEqual(checked.sort());
});
