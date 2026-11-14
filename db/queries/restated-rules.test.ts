import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BLOCKED_STAGES, FOUND_OUTCOMES, PARKED, parked } from '../../app/lib/board';
import { STOP_CLASSES } from '../../app/lib/failures';
import { causeOf } from '../../app/lib/health';
import {
  APP_CHECK_WORKFLOW,
  BUILD_QUEUE_WORKFLOW,
  INTAKE_WORKFLOW,
  OLD_LOOP_WORKFLOW,
  prNumber,
  SPLIT_WORKFLOW,
} from '../../app/lib/one-lap';
import { runsArgs } from '../../app/lib/runs';
import { QUEUE_ENDING_STATE, QUEUE_REVIEW_STATE, REVIEW_OUTCOME_STATE } from '../../app/lib/states';
import { ROUTE_OF_LABEL, WORK_ITEM_NUMBER } from '../../app/lib/work-item';
import { FAILED_SIGNATURES_SQL } from '../../scripts/live/attention';
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

test('health-workable.sql excludes the workflows board.ts says hold no work item', () => {
  expect(
    [...sqlOf('health-workable').matchAll(/workflow_name <> '([^']*)'/g)].map((m) => m[1]),
  ).toEqual([SPLIT_WORKFLOW]);
});

test('work-item.sql, scorecard.sql and unstick.sql name only the workflows one-lap.ts owns', () => {
  const owned = new Set([OLD_LOOP_WORKFLOW, BUILD_QUEUE_WORKFLOW, INTAKE_WORKFLOW]);
  for (const file of ['work-item.sql', 'scorecard.sql', 'unstick.sql']) {
    const named = [...read('db', 'queries', file).matchAll(/workflow_name\s*=\s*'([^']*)'/g)].map(
      (m) => m[1] as string,
    );
    expect(named.length, file).toBeGreaterThan(0);
    for (const name of named) expect(owned.has(name), `${file}: ${name}`).toBe(true);
  }
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

test('a version no pin names is the newest parsed, though after the lap started, in both one-lap queries', async () => {
  const db = await migratedDb();
  try {
    await db.query(
      `INSERT INTO mc.factories (name, repository, codebase, console) VALUES ('f', 'o/r', 'o/r', 'c')`,
    );
    const runId = '5eed0000-0000-4000-8000-000000000009';
    await db.query(
      `INSERT INTO mc.laps (run_id, factory, workflow_name, status, started_at)
       VALUES ($1, 'f', 'archon-build-queue', 'completed', '2026-10-20')`,
      [runId],
    );
    await db.query(
      `INSERT INTO mc.lap_steps (run_id, step_id, status, started_at) VALUES ($1, 'x', 'completed', now())`,
      [runId],
    );
    // Position names the version chosen: the step pages take the newest parse, so the map does too.
    for (const [sha, parsed, position] of [
      ['u1', '2026-09-01', 1],
      ['u2', '2026-12-01', 2],
    ] as const) {
      await db.query(
        `INSERT INTO mc.arch_versions (archon_sha, factory_sha, parsed_at) VALUES ($1, 'fs', $2)`,
        [sha, parsed],
      );
      await db.query(
        `INSERT INTO mc.arch_steps (archon_sha, factory_sha, workflow, path, position, step_id, kind, defined_in, file)
         VALUES ($1, 'fs', 'archon-build-queue', 'x', $2, 'x', 'command', 'archon-build-queue', 'f')`,
        [sha, position],
      );
    }
    for (const name of ['one-lap-steps', 'one-lap-map']) {
      const rows = await db.query(sqlOf(name), ['f', runId]);
      expect([name, rows.map((r) => r.position)]).toEqual([name, [2]]);
    }
  } finally {
    await db.close();
  }
}, 60_000);

test('a factory that never ran the queues draws a lap at its pin, though an unpinned version holds the workflow, in both one-lap queries', async () => {
  const db = await migratedDb();
  try {
    await db.query(
      `INSERT INTO mc.factories (name, repository, codebase, console) VALUES ('f', 'o/r', 'o/r', 'c')`,
    );
    const runId = '5eed0000-0000-4000-8000-00000000000b';
    await db.query(
      `INSERT INTO mc.laps (run_id, factory, workflow_name, status, started_at)
       VALUES ($1, 'f', 'archon-merge-queue', 'completed', '2026-10-20')`,
      [runId],
    );
    await db.query(
      `INSERT INTO mc.lap_steps (run_id, step_id, status, started_at) VALUES ($1, 'x', 'completed', now())`,
      [runId],
    );
    await db.query(
      `INSERT INTO mc.pins (sha, archon_sha, committed_at) VALUES ('p1', 'pinned', '2026-10-01')`,
    );
    // Position names the version chosen.
    for (const [sha, position] of [
      ['pinned', 1],
      ['unpinned', 2],
    ] as const) {
      await db.query(
        `INSERT INTO mc.arch_versions (archon_sha, factory_sha, parsed_at) VALUES ($1, 'fs', '2026-09-01')`,
        [sha],
      );
      await db.query(
        `INSERT INTO mc.arch_steps (archon_sha, factory_sha, workflow, path, position, step_id, kind, defined_in, file)
         VALUES ($1, 'fs', 'archon-merge-queue', 'x', $2, 'x', 'command', 'archon-merge-queue', 'f')`,
        [sha, position],
      );
    }
    for (const name of ['one-lap-steps', 'one-lap-map']) {
      const rows = await db.query(sqlOf(name), ['f', runId]);
      expect([name, rows.map((r) => r.position)]).toEqual([name, [1]]);
    }
  } finally {
    await db.close();
  }
}, 60_000);

test('mc.lap_steps.pr_number reads a step pr, else its pr_url', async () => {
  const pull = (n: number) => `https://github.com/o/r/pull/${n}`;
  const outputs: [object, number | null][] = [
    [{ pr: '#7' }, 7],
    [{ pr: '#7', pr_url: pull(9) }, 7],
    [{ pr: '', pr_url: pull(9) }, 9],
    [{ pr_url: pull(9) }, 9],
    [{ pr_url: null }, null],
    [{ pr_url: 'https://github.com/o/r/issues/9' }, null],
  ];
  const db = await migratedDb();
  try {
    for (const [i, [output, expected]] of outputs.entries()) {
      const run = `00000000-0000-4000-8000-${String(1000 + i).padStart(12, '0')}`;
      await db.query(
        `INSERT INTO mc.lap_steps (run_id, step_id, status, output) VALUES ($1, 'round', 'completed', $2)`,
        [run, JSON.stringify(output)],
      );
      const [row] = await db.query(`SELECT pr_number FROM mc.lap_steps WHERE run_id = $1`, [run]);
      expect(row?.pr_number, JSON.stringify(output)).toBe(expected);
    }
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
      // The pack the factory runs no longer writes or reads `own_pr` (Archon #5391); an old row's
      // own_pr_at stays in the state and decides nothing.
      const { own_pr, ...facts } = d.facts as Record<string, unknown>;
      expect(row?.own_pr_at ?? null, JSON.stringify(d.facts)).toBe(
        (own_pr as { at: string } | undefined)?.at ?? null,
      );
      const current = { ...d, facts };
      const f = facts as Record<string, { status?: string; at: string } | undefined>;
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
      const expected =
        !retriaged && parkedAt !== null && !buildWaits(current) && !mergeWaits(current);
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

test('the statuses the Board places by are the pinned pack’s', () => {
  const build = statusUnion('build.ts', 'BuildStatus');
  const merge = statusUnion('merge.ts', 'MergeStatus');
  for (const status of ['ready', 'asking']) expect(build).toContain(status);
  for (const status of ['waiting', 'returned', 'asking']) expect(merge).toContain(status);
});

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

const PARKED_RULE = /w\.build_status = 'parked'[\s\S]*?w\.build_at > w\.merge_at, false\)/;
const squashed = (text: string) => text.replace(/\s+/g, ' ').trim();

test('the Unstick parked rule is health-workable’s, verbatim', () => {
  const rule = (name: string) => PARKED_RULE.exec(sqlOf(name))?.[0] ?? '';
  expect(rule('health-workable')).not.toBe('');
  expect(squashed(rule('unstick'))).toBe(squashed(rule('health-workable')));
});

// The pack releases a claim when the engine reports its lease ended (`claimEnded`), a rule the
// engine owns: the snapshot's README is where it states which run statuses keep the claim.
test('a claim is stale in Unstick for exactly the run statuses the pinned pack releases', async () => {
  const { claimEnded } = await pack('queue', 'sdlc', '.shared', 'state.ts');
  expect(typeof claimEnded).toBe('function');
  const readme = squashed(read('fixtures', 'pack', 'queue', 'sdlc', 'README.md'));
  const held = /A claim whose run is ([a-z, ]+?),? or ([a-z]+) is never released/.exec(readme);
  expect(held, 'the pack README no longer states which runs keep a claim').not.toBeNull();
  const kept = [...(held?.[1] ?? '').split(','), held?.[2] ?? ''].map((s) => s.trim());
  const released = ['pending', 'running', 'paused', 'completed', 'failed', 'cancelled'].filter(
    (status) => !kept.includes(status),
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
  // `idle`, `order` and `handoff` pick no item (apply.ts `noItemSummary`) and `launch` throws, so
  // none ends a delivery round: a new decision fails here until it is worded or listed.
  expect(unworded.sort()).toEqual(['handoff', 'idle', 'launch', 'order']);
  expect(Object.keys(QUEUE_ENDING_STATE).every((d) => decisions.includes(d))).toBe(true);
});

test('the work item page words exactly the build-queue review actions', () => {
  const actions = yamlEnum(['queue', 'sdlc', 'review', 'archon-review.yaml'], 'publish', 'action');
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

test('runs, home-map and health-workable resolve the same item for every source of it', async () => {
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
    const lanes = (
      await db.query(sqlOf('runs'), [
        'f',
        ...runsArgs({ q: '', state: '', hideIdle: false, page: 1 }),
      ])
    ).filter((r) => r.status === 'running');
    const laps = (await db.query(sqlOf('home-map'), ['f', ''])).filter((r) => r.kind === 'lap');
    expect(held(lanes)).toEqual(expected);
    expect(held(laps)).toEqual(expected);
    expect(titled(lanes, 'issue_title')).toEqual(expectedTitles);
    expect(titled(laps, 'title')).toEqual(expectedTitles);
    // The run page names the same item, and has no status filter: the completed run 7 is on it too.
    const page = await Promise.all(
      Object.keys(runs).map(
        async (c) =>
          ((await db.query(sqlOf('one-lap'), ['f', id(c)]))[0] ?? {}) as Record<string, unknown>,
      ),
    );
    expect(Object.fromEntries(page.map((r) => [r.run_id, r.issue_number ?? null]))).toEqual({
      ...expected,
      [id('7')]: 7,
    });
    expect(Object.fromEntries(page.map((r) => [r.run_id, r.issue_title ?? null]))).toEqual({
      ...expectedTitles,
      [id('7')]: 't7',
    });
    const workable = (await db.query(sqlOf('health-workable'), ['f']))
      .flatMap((r) => (r.kind === 'issue' ? [r.issue_number as number] : []))
      .sort();
    // A split run shows its item on Laps and the map, but holds nothing: 8 stays workable.
    expect(workable).toEqual([6, 7, 8]);
  } finally {
    await db.close();
  }
});

test('failure-groups resolves a failure by a later run on the item every other screen holds', async () => {
  const db = await migratedDb();
  try {
    await db.query(
      `INSERT INTO mc.factories (name, repository, codebase, console) VALUES ('f', 'o/r', 'o/r', 'c')`,
    );
    for (let n = 1; n <= 3; n++) {
      await db.query(
        `INSERT INTO mc.issues (factory, number, title, state, url, created_at, updated_at)
         VALUES ('f', $1, $2, 'open', 'u', now(), now())`,
        [n, `t${n}`],
      );
    }
    let k = 0;
    const lap = async (
      workflow: string,
      status: 'failed' | 'completed',
      day: string,
      src: { claim?: number; facts?: number; input?: number },
    ) => {
      const id = `5eed0000-0000-4000-8000-${String(++k).padStart(12, '0')}`;
      const at = `${day}T09:00:00Z`;
      await db.query(
        `INSERT INTO mc.laps (run_id, factory, workflow_name, status, started_at, completed_at, issue_number)
         VALUES ($1, 'f', $2, $3, $4::timestamptz, $4::timestamptz, $5)`,
        [id, workflow, status, at, src.input ?? null],
      );
      if (src.facts !== undefined) {
        await db.query(
          `INSERT INTO mc.lap_steps (run_id, step_id, status, started_at, output)
           VALUES ($1, 'facts', 'completed', $2::timestamptz, $3)`,
          [id, at, JSON.stringify({ item: { number: src.facts } })],
        );
      }
      if (src.claim !== undefined) {
        await db.query(
          `INSERT INTO mc.claims (factory, issue_number, run_id, claimed_at, released_at)
           VALUES ('f', $1, $2, $3::timestamptz, $3::timestamptz)`,
          [src.claim, id, at],
        );
      }
      if (status === 'failed') {
        await db.query(
          `INSERT INTO mc.lap_steps (run_id, step_id, status, completed_at, error)
           VALUES ($1, 'prepare', 'failed', $2::timestamptz, $3)`,
          [id, at, `error: ${workflow}`],
        );
      }
    };
    type Src = { claim?: number; facts?: number; input?: number };
    // The failed run and the later completed run each hold the item their sources name, by the shared
    // claim > facts > input precedence: either side reversing it changes which cases resolve.
    const cases: { workflow: string; src: Src; later: Src; resolved: boolean }[] = [
      {
        workflow: 'claim-wins',
        src: { claim: 1, facts: 2, input: 3 },
        later: { input: 1 },
        resolved: true,
      },
      {
        workflow: 'claim-only',
        src: { claim: 1, facts: 2, input: 3 },
        later: { input: 2 },
        resolved: false,
      },
      { workflow: 'facts-wins', src: { facts: 2, input: 3 }, later: { input: 2 }, resolved: true },
      {
        workflow: 'facts-over-input',
        src: { facts: 2, input: 3 },
        later: { input: 3 },
        resolved: false,
      },
      { workflow: 'input-only', src: { input: 3 }, later: { input: 3 }, resolved: true },
      {
        workflow: 'later-claim-wins',
        src: { input: 1 },
        later: { claim: 1, facts: 2, input: 3 },
        resolved: true,
      },
      {
        workflow: 'later-claim-only',
        src: { input: 1 },
        later: { claim: 2, facts: 1, input: 1 },
        resolved: false,
      },
      {
        workflow: 'later-facts-wins',
        src: { input: 1 },
        later: { facts: 1, input: 3 },
        resolved: true,
      },
      {
        workflow: 'later-facts-over-input',
        src: { input: 1 },
        later: { facts: 2, input: 1 },
        resolved: false,
      },
    ];
    for (const c of cases) {
      await lap(c.workflow, 'failed', '2026-10-20', c.src);
      await lap(c.workflow, 'completed', '2026-10-21', c.later);
    }
    const counted = (
      await db.query(sqlOf('failure-groups'), ['f', '2000-01-01T00:00:00.000Z'])
    ).map((g) => g.workflow_name);
    expect(counted.sort()).toEqual(
      cases
        .filter((c) => !c.resolved)
        .map((c) => c.workflow)
        .sort(),
    );
    // The run page restates the later run's item in one-lap.sql: it finishes the same runs.
    for (const c of cases) {
      const [failed] = await db.query(
        `SELECT run_id FROM mc.laps WHERE factory = 'f' AND workflow_name = $1 AND status = 'failed'`,
        [c.workflow],
      );
      const [row] = await db.query(sqlOf('one-lap'), ['f', failed?.run_id]);
      expect([c.workflow, row?.finished_by !== null]).toEqual([c.workflow, c.resolved]);
    }
  } finally {
    await db.close();
  }
}, 60_000);

test('failure-groups and the run page agree on which failed runs are finished', async () => {
  const db = await migratedDb();
  try {
    await db.query(
      `INSERT INTO mc.factories (name, repository, codebase, console) VALUES ('f', 'o/r', 'o/r', 'c')`,
    );
    const issue = (n: number, state: 'open' | 'closed') =>
      db.query(
        `INSERT INTO mc.issues (factory, number, title, state, url, created_at, updated_at, closed_at)
         VALUES ('f', $1, 't', $2, 'u', now(), now(), CASE WHEN $2 = 'closed' THEN now() END)`,
        [n, state],
      );
    const pull = (n: number, state: 'open' | 'closed') =>
      db.query(
        `INSERT INTO mc.pull_requests (factory, number, title, state, head_sha, url, created_at, updated_at, closed_at)
         VALUES ('f', $1, 't', $2, 'sha', 'u', now(), now(), CASE WHEN $2 = 'closed' THEN now() END)`,
        [n, state],
      );
    let k = 0;
    const lap = async (
      workflow: string,
      status: 'failed' | 'completed',
      at: string,
      src: { issue?: number; pr?: number; transient?: boolean },
    ) => {
      const id = `5eed0000-0000-4000-8000-${String(++k).padStart(12, '0')}`;
      await db.query(
        `INSERT INTO mc.laps (run_id, factory, workflow_name, status, started_at, completed_at, issue_number)
         VALUES ($1, 'f', $2, $3, $4::timestamptz, $4::timestamptz, $5)`,
        [id, workflow, status, at, src.issue ?? null],
      );
      if (src.pr !== undefined) {
        await db.query(
          `INSERT INTO mc.lap_steps (run_id, step_id, status, pr_number) VALUES ($1, 'select', 'completed', $2)`,
          [id, src.pr],
        );
      }
      if (status === 'failed') {
        await db.query(
          `INSERT INTO mc.lap_steps (run_id, step_id, status, completed_at, error)
           VALUES ($1, 'prepare', 'failed', $2::timestamptz, $3)`,
          [
            id,
            at,
            src.transient
              ? "Couldn't connect to compute node"
              : `error: case ${String.fromCharCode(96 + k)}${String.fromCharCode(96 + k)}`,
          ],
        );
      }
      return id;
    };
    const oct = (day: number) => `2026-10-${day}T09:00:00Z`;
    await issue(1, 'open');
    await issue(2, 'open');
    await issue(3, 'closed');
    await issue(4, 'open');
    await pull(70, 'closed');
    await pull(71, 'open');

    const later = await lap('w1', 'failed', oct(20), { issue: 1 });
    const laterDone = await lap('w1', 'completed', oct(21), { issue: 1 });
    await lap('w2', 'failed', oct(20), { issue: 2 });
    await lap('w2', 'failed', oct(21), { issue: 2 });
    await lap('w3', 'failed', oct(20), { issue: 2 });
    await lap('other', 'completed', oct(21), { issue: 2 });
    await lap('w4', 'completed', oct(10), { issue: 2 });
    await lap('w4', 'failed', oct(20), { issue: 2 });
    await lap('w5', 'failed', oct(20), { issue: 3 });
    await lap('w6', 'failed', oct(20), { pr: 70 });
    await lap('w7', 'failed', oct(20), { pr: 71 });
    await lap('w8', 'failed', oct(20), { pr: 71 });
    await lap('w8', 'completed', oct(21), { pr: 71 });
    await lap('w9', 'failed', oct(20), {});
    await lap('w9', 'completed', oct(21), { issue: 4 });
    await lap('w10', 'failed', oct(20), {});
    await lap('other', 'completed', oct(22), {});
    // The one exception, kept on purpose: a transient failure is also retried by a run on any other item.
    const retried = await lap('w11', 'failed', oct(20), { issue: 1, transient: true });
    await lap('w11', 'completed', oct(21), { issue: 2 });

    const groups = await db.query(sqlOf('failure-groups'), ['f', '2000-01-01T00:00:00.000Z']);
    const counted = new Set(groups.map((g) => g.latest_run_id));
    const failed = await db.query(
      `SELECT run_id FROM mc.laps WHERE factory = 'f' AND status = 'failed'`,
    );
    expect(failed).toHaveLength(12);
    for (const { run_id } of failed) {
      const [row] = await db.query(sqlOf('one-lap'), ['f', run_id]);
      const finished = row?.item_closed_at !== null || row?.finished_by !== null;
      if (run_id === retried) {
        expect([run_id, counted.has(run_id as string), finished]).toEqual([run_id, false, false]);
      } else {
        expect([run_id, counted.has(run_id as string)]).toEqual([run_id, !finished]);
      }
    }
    expect((await db.query(sqlOf('one-lap'), ['f', later]))[0]?.finished_by).toBe(laterDone);
  } finally {
    await db.close();
  }
}, 60_000);

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
    // The owner's answer: runs.sql holds each (running) run on an item; a shipped loop/queue run is a round there.
    const owned: Record<number, number> = {};
    for (const row of await db.query(sqlOf('runs'), [
      'f',
      ...runsArgs({ q: '', state: '', hideIdle: false, page: 1 }),
    ])) {
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

// The newest migration that replaces mc.project_run_stop is the projector Postgres runs.
const projectorSql = () =>
  migrationFiles.findLast((f) => /CREATE OR REPLACE FUNCTION mc\.project_run_stop/.test(f.sql))
    ?.sql ?? '';

test('mc.stop_class refines Health’s causes, agreeing with causeOf on every corpus line', async () => {
  const sql = projectorSql();
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

test('the runs idle-poll rule names app-check steps the workflow gates on a selected check', () => {
  const workflow = read('.archon', 'workflows', 'factory', 'app-check', 'factory-app-check.yaml');
  const steps = new Map(
    workflow
      .replaceAll('\r\n', '\n')
      .split(/^ {2}- id: /m)
      .slice(1)
      .map((block) => [block.split('\n')[0], block] as const),
  );
  const rule = sqlOf('runs').match(/o\.step_id IN \(([^)]*)\)/);
  expect(rule).not.toBeNull();
  expect(steps.has('select')).toBe(true);
  for (const id of quoted(rule?.[1] ?? '')) {
    expect(steps.get(id)).toContain('when: "$select.output.found == true"');
  }
  expect(quoted(rule?.[1] ?? '').length).toBeGreaterThan(0);
});

test('the runs queries read the pack idle value, round step address and app check name as the pack spells them', () => {
  const pack = (...path: string[]) => read('fixtures', 'pack', 'queue', 'sdlc', ...path);
  const idle = sqlOf('runs').match(/'path' = '([^']*)'/)?.[1] ?? '';
  // runs.sql joins the `facts` step of every queue workflow, so every pack that has one is bound.
  const packRoot = join(root, 'fixtures', 'pack', 'queue', 'sdlc');
  let withFacts = 0;
  for (const { name: dir } of readdirSync(packRoot, { withFileTypes: true }).filter((e) =>
    e.isDirectory(),
  )) {
    for (const file of readdirSync(join(packRoot, dir)).filter((f) => f.endsWith('.yaml'))) {
      const facts = pack(dir, file)
        .replaceAll('\r\n', '\n')
        .match(/^ {2}- id: facts\n[\s\S]*?path: \{ type: string, enum: \[([^\]]*)\] \}/m)?.[1];
      if (facts === undefined) continue;
      withFacts += 1;
      expect({ file, idle: facts.split(',').map((v) => v.trim()) }).toEqual({
        file,
        idle: expect.arrayContaining([idle]),
      });
    }
  }
  expect(withFacts).toBe(5);

  // The round step's address: the build queue's `ship` > the ship block's `deliver` > the deliver
  // block's loop `rounds` > its `round` step, joined the way mc.lap_steps writes it.
  const ids = (file: string[], pattern: RegExp) =>
    pack(...file)
      .replaceAll('\r\n', '\n')
      .match(pattern)?.[1];
  const address = `${ids(['build-queue', 'archon-build-queue.yaml'], /^ {2}- id: (ship)$/m)}__${ids(['build-route', 'archon-build.yaml'], /^ {2}- id: (deliver)$/m)}__${ids(['deliver', 'archon-deliver.yaml'], /^ {2}- id: (rounds)$/m)}.${ids(['deliver', 'archon-deliver.yaml'], /^ {8}- id: (round)$/m)}`;
  for (const name of ['runs', 'work-item']) {
    expect(quoted(sqlOf(name).match(/step_id = '([^']*round)'/)?.[0] ?? '')).toEqual([address]);
  }
  // The page reads the review block's verdict from the step its `returns:` names.
  const returns = ids(['review', 'archon-review.yaml'], /^returns: (\S+)$/m);
  expect(returns).toBeDefined();
  expect(sqlOf('work-item')).toContain(`ship__deliver__rounds.review__${returns}`);

  const appCheck = read('.archon', 'workflows', 'factory', 'app-check', 'factory-app-check.yaml');
  const checkName = appCheck.match(/^name: (\S+)/m)?.[1];
  expect(sqlOf('runs')).toContain(`l.workflow_name = '${checkName}'`);
  expect(APP_CHECK_WORKFLOW).toBe(checkName as string);
});

test('the run-stop migration writes only classes and stopped statuses its CHECKs allow', () => {
  // The table CHECK lives in 0031, the class function in the newest migration that replaces it; the guard is the live projector's.
  const sql = read('db', 'migrations', '0031_run_stops.sql');
  const guardSql = projectorSql();
  const classSql =
    migrationFiles.findLast((f) => /CREATE OR REPLACE FUNCTION mc\.stop_class/.test(f.sql))?.sql ??
    '';
  const classFn = classSql.match(/FUNCTION mc\.stop_class[\s\S]*?\$\$;/)?.[0] ?? '';
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

test('runs, home-map and health-workable hold the same item of a run with several claims', async () => {
  const db = await migratedDb();
  try {
    await db.query(
      `INSERT INTO mc.factories (name, repository, codebase, console) VALUES ('f', 'o/r', 'o/r', 'c')`,
    );
    for (let n = 1; n <= 7; n++) {
      await db.query(
        `INSERT INTO mc.issues (factory, number, title, state, url, created_at, updated_at)
         VALUES ('f', $1, $2, 'open', 'u', now(), now())`,
        [n, `t${n}`],
      );
    }
    const id = (c: string) => `5eed0000-0000-4000-8000-00000000000${c}`;
    // Per run: [issue, claimed_at] claims, and the issue the newest holds.
    const runs = {
      // The later claim wins whatever its number: DESC on claimed_at.
      '1': {
        claims: [
          [2, '2026-01-01'],
          [1, '2026-01-02'],
        ],
        holds: 1,
      },
      // A tie on claimed_at falls to the lower number.
      '2': {
        claims: [
          [4, '2026-01-01'],
          [3, '2026-01-01'],
        ],
        holds: 3,
      },
      // A claim with no claimed_at is the oldest, though it has the lower number.
      '3': {
        claims: [
          [5, null],
          [6, '2026-01-01'],
        ],
        holds: 6,
      },
    } as const;
    for (const [c, r] of Object.entries(runs)) {
      await db.query(
        `INSERT INTO mc.laps (run_id, factory, workflow_name, status, started_at)
         VALUES ($1, 'f', 'archon-loop', 'running', now())`,
        [id(c)],
      );
      await db.query(
        `INSERT INTO mc.lap_steps (run_id, step_id, status, output, started_at, completed_at)
         VALUES ($1, 'land', 'completed', '{"outcome":"merged"}', now(), now())`,
        [id(c)],
      );
      for (const [issue, at] of r.claims) {
        await db.query(
          `INSERT INTO mc.claims (factory, issue_number, run_id, claimed_at, released_at)
           VALUES ('f', $1, $2, $3, now())`,
          [issue, id(c), at],
        );
      }
    }
    const expected = Object.fromEntries(Object.entries(runs).map(([c, r]) => [id(c), r.holds]));
    const held = (rows: Record<string, unknown>[]) =>
      Object.fromEntries(rows.map((r) => [r.run_id as string, r.issue_number ?? r.number ?? null]));
    const lanes = (
      await db.query(sqlOf('runs'), [
        'f',
        ...runsArgs({ q: '', state: '', hideIdle: false, page: 1 }),
      ])
    ).filter((r) => r.status === 'running');
    const laps = (await db.query(sqlOf('home-map'), ['f', ''])).filter((r) => r.kind === 'lap');
    expect(held(lanes)).toEqual(expected);
    expect(held(laps)).toEqual(expected);
    const merged = (await db.query(sqlOf('home-map'), ['f', ''])).filter(
      (r) => r.kind === 'merged',
    );
    expect(held(merged)).toEqual(expected);
    for (const [c, r] of Object.entries(runs)) {
      const [lap] = await db.query(sqlOf('one-lap'), ['f', id(c)]);
      expect([c, lap?.issue_number]).toEqual([c, r.holds]);
    }
    const workable = (await db.query(sqlOf('health-workable'), ['f']))
      .flatMap((r) => (r.kind === 'issue' ? [r.issue_number as number] : []))
      .sort();
    // Only the newest claim of each run holds its item; the other claims' items stay workable.
    expect(workable).toEqual([2, 4, 5, 7]);
  } finally {
    await db.close();
  }
});

test('one-lap-steps and one-lap-map choose the same architecture for a lap', async () => {
  const db = await migratedDb();
  try {
    await db.query(
      `INSERT INTO mc.factories (name, repository, codebase, console) VALUES ('f', 'o/r', 'o/r', 'c')`,
    );
    // Each version places step x at its own position, so the position names the version a query chose.
    // v3 and v4 are pins committed at the same moment: the one parsed last wins.
    const versions = [
      { pin: 'p1', at: '2026-01-01', parsed: '2026-06-01', position: 1 },
      { pin: 'p2', at: '2026-02-01', parsed: '2026-06-01', position: 2 },
      { pin: 'p3', at: '2026-03-01', parsed: '2026-06-01', position: 3 },
      { pin: 'p4', at: '2026-03-01', parsed: '2026-06-02', position: 4 },
    ];
    for (const v of versions) {
      await db.query(
        `INSERT INTO mc.pins (sha, archon_sha, reason, committed_at) VALUES ($1, $1, 'r', $2)`,
        [v.pin, v.at],
      );
      await db.query(
        `INSERT INTO mc.arch_versions (archon_sha, factory_sha, parsed_at) VALUES ($1, 'fs', $2)`,
        [v.pin, v.parsed],
      );
      await db.query(
        `INSERT INTO mc.arch_steps (archon_sha, factory_sha, workflow, path, position, step_id, kind, defined_in, file)
         VALUES ($1, 'fs', 'archon-loop', 'x', $2, 'x', 'command', 'archon-loop', 'f')`,
        [v.pin, v.position],
      );
    }
    // A pin whose architecture is not stored is never chosen.
    await db.query(
      `INSERT INTO mc.pins (sha, archon_sha, reason, committed_at) VALUES ('p5', 'p5', 'r', '2026-04-01')`,
    );
    const laps = {
      // Straddles the pins: the newest pin committed before it starts.
      '1': { startedAt: '2026-02-15', position: 2 },
      // Older than every pin: the oldest.
      '2': { startedAt: '2025-12-01', position: 1 },
      // Not started yet: the newest, and of two committed together the one parsed last.
      '3': { startedAt: null, position: 4 },
    } as const;
    for (const [c, l] of Object.entries(laps)) {
      const runId = `5eed0000-0000-4000-8000-00000000000${c}`;
      await db.query(
        `INSERT INTO mc.laps (run_id, factory, workflow_name, status, started_at)
         VALUES ($1, 'f', 'archon-loop', 'running', $2)`,
        [runId, l.startedAt],
      );
      await db.query(
        `INSERT INTO mc.lap_steps (run_id, step_id, status, started_at) VALUES ($1, 'x', 'completed', now())`,
        [runId],
      );
      const inSteps = (await db.query(sqlOf('one-lap-steps'), ['f', runId])).map((r) => r.position);
      const inMap = (await db.query(sqlOf('one-lap-map'), ['f', runId])).map((r) => r.position);
      expect([c, inSteps, inMap]).toEqual([c, [l.position], [l.position]]);
    }
  } finally {
    await db.close();
  }
}, 60_000);

test('the retried rule reads the same in failure-groups, retried-runs and the live Attention check', async () => {
  const db = await migratedDb();
  try {
    await db.query(
      `INSERT INTO mc.factories (name, repository, codebase, console) VALUES ('f', 'o/r', 'o/r', 'c')`,
    );
    let n = 0;
    const lap = async (workflow: string, status: string, at: string, error?: string) => {
      const id = `5eed0000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
      await db.query(
        `INSERT INTO mc.laps (run_id, factory, workflow_name, status, started_at, completed_at)
         VALUES ($1, 'f', $2, $3, $4::timestamptz, $4::timestamptz)`,
        [id, workflow, status, at],
      );
      if (error !== undefined) {
        await db.query(
          `INSERT INTO mc.lap_steps (run_id, step_id, status, completed_at, error)
           VALUES ($1, 'facts', 'failed', $2::timestamptz, $3)`,
          [id, at, error],
        );
      }
      return id;
    };
    const blip = "Couldn't connect to compute node";
    const first = await lap('ticks', 'failed', '2026-10-24T08:00:00Z', blip);
    const second = await lap('ticks', 'failed', '2026-10-24T08:20:00Z', blip);
    await lap('ticks', 'completed', '2026-10-24T08:30:00Z');
    await lap('stuck', 'failed', '2026-10-24T09:00:00Z', blip);
    await lap('steady', 'failed', '2026-10-24T07:00:00Z', 'error: type check failed');
    await lap('steady', 'completed', '2026-10-24T07:30:00Z');
    await lap('solo', 'failed', '2026-10-24T07:40:00Z', 'error: lint failed');
    // Resolved by age, at the cutoff exactly and before it, and by a closed item.
    await lap('aged', 'failed', '2026-10-17T00:00:00Z', 'error: aged at the cutoff');
    await lap('aged', 'failed', '2026-10-10T00:00:00Z', 'error: aged before the cutoff');
    await db.query(
      `INSERT INTO mc.issues (factory, number, title, state, url, created_at, updated_at)
       VALUES ('f', 7, 't', 'closed', 'u', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z')`,
    );
    const onClosed = await lap('closing', 'failed', '2026-10-24T07:50:00Z', 'error: closed item');
    await db.query(
      `INSERT INTO mc.claims (factory, issue_number, run_id, claimed_at)
       VALUES ('f', 7, $1, '2026-10-24T07:50:00Z')`,
      [onClosed],
    );

    const since = '2026-10-17T00:00:00.000Z';
    const sqlOf = (name: string) => queries.find(([q]) => q === name)?.[1] as string;
    const cards = (await db.query(sqlOf('failure-groups'), ['f', since]))
      .map((g) => g.signature)
      .sort();
    const live = (await db.query(FAILED_SIGNATURES_SQL, ['f', since]))
      .map((r) => r.signature)
      .sort();
    expect(cards).toEqual(live);
    expect(cards).toHaveLength(2);
    const retried = await db.query(sqlOf('retried-runs'), ['f', '2026-10-24T00:00:00.000Z']);
    expect(retried.map((r) => r.run_id)).toEqual([second, first]);
  } finally {
    await db.close();
  }
}, 60_000);

test('the work-item facts the Board projects are the pinned pack’s words', () => {
  const migration = read('db', 'migrations', '20261113T1400Z_board_item_facts.sql');
  const label = /d ->> 'decision' = '([^']*)'/.exec(migration)?.[1] ?? '';
  expect(label).not.toBe('');
  expect(read('fixtures/pack/queue/sdlc/merge-queue/scripts/record.ts')).toContain(
    `decision: '${label}'`,
  );
  const merged = /st\.merge_status = '([^']*)'/.exec(sqlOf('board'))?.[1] ?? '';
  expect(statusUnion('merge.ts', 'MergeStatus')).toContain(merged);
  const shape = /export interface BuildRound \{([\s\S]*?)\n\}/.exec(
    read('fixtures', 'pack', 'queue', 'sdlc', '.shared', 'build.ts'),
  )?.[1];
  expect(shape, 'build.ts declares BuildRound').toBeDefined();
  const keys = new Set([...(shape ?? '').matchAll(/^ {2}readonly (\w+)\??:/gm)].map((m) => m[1]));
  const roundKeys = [
    ...migration.matchAll(/\br -> '(\w+)'/g),
    ...migration.matchAll(/\br ->> '(\w+)'/g),
    ...migration.matchAll(/'rounds' -> -1 ->> '(\w+)'/g),
  ].map((m) => m[1]);
  for (const key of roundKeys) expect(keys, `BuildRound key '${key}'`).toContain(key);
  expect(roundKeys).toEqual(expect.arrayContaining(['at', 'reason', 'reviews', 'run_id']));
});
