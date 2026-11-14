// Each screen's test:live phase is one module under scripts/live/ returning a LivePhase; adding a
// screen is one new module and one entry in `SCREENS` (its phase, its outputs and its --help prose). Helpers two modules use live in
// scripts/live/shared.ts.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createRealtimeClient, type WebSocketLike } from '@neon/realtime/client';
import { createRealtime, rawSql } from '@neon/realtime/server';
import { loadLiveQueries, parameterCount, realtimeUrlFor } from '../server/live';
import { QUEUE_FACTORY, SECOND_FACTORY } from './fixture/seed';
import { type Deps, failing, guardedDatabaseUrl, type Main, runCli } from './lib/cli';
import { machineLockPath, withMachineLock } from './lib/machine-lock';
import { resolveBranchName } from './lib/target';
import { ATTENTION_OUTPUTS, attentionPhase } from './live/attention';
import { BOARD_OUTPUTS, boardPhase } from './live/board';
import { HOME_OUTPUTS, homePhase } from './live/home';
import { MANAGER_OUTPUTS, managerPhase } from './live/manager';
import { ONE_LAP_OUTPUTS, oneLapPhase } from './live/one-lap';
import { QUEUE_MAP_OUTPUTS, QUEUE_MAP_VIEWS, queueMapPhase } from './live/queue-map';
import { RUNS_OUTPUTS, runsPhase } from './live/runs';
import {
  fixtureWrite,
  freePort,
  LIVE_STEP,
  type LiveContext,
  type LiveOutput,
  type LivePhase,
  liveOutputs,
  READY_WAIT_MS,
  waitForHealth,
} from './live/shared';
import { STEP_DETAIL_OUTPUTS, stepDetailPhase } from './live/step-detail';
import { SWITCHER_OUTPUTS, switcherPhase } from './live/switcher';
import { measurePanels } from './live/timings';
import { WORK_ITEM_OUTPUTS, workItemPhase } from './live/work-item';

const RUNNER_FILES = liveOutputs({
  factories: 'factories.json',
  features: 'realtime-features.json',
});

/** One screen of test:live: its phase, the files it writes and its --help prose (naming no file). */
interface LiveScreen {
  phase?: (ctx: LiveContext) => LivePhase;
  outputs: readonly LiveOutput[];
  help: readonly string[];
}

/**
 * The runner first, then every phase in the order of every write against every read that judges
 * it: the laps screen and the lap open before the strip's first insert, and the Attention page
 * removes its own labels as soon as it has timed them.
 */
export const SCREENS: readonly LiveScreen[] = [
  {
    outputs: Object.values(RUNNER_FILES),
    help: [
      'Proves the screens are live against the check branch in .mc-check.env (run',
      '`bun run fixture:branch` first): serves the app on a free port in 8850-8864 (waiting up to 30',
      'minutes while every one is taken), reading a factories file (in --out, as MC_FACTORIES_FILE) of',
      "factories.json plus the seed's second and queue factories, re-runs the probes in",
      'db/queries/REALTIME.md, subscribes every file in db/queries/ and fails naming each Realtime refuses,',
      'and writes every file below to --out (default harness/.results/live).',
    ],
  },
  {
    phase: homePhase,
    outputs: HOME_OUTPUTS,
    help: [
      "It opens `/` in a headless browser, checks the map's cards and their lap counts against the",
      'seed, times inserted laps to the factory strip and `fixture:write step` events to the map,',
      "holds the page open --hold seconds (default 180) across seal renewals, follows App check's",
      "Behind the scenes to check-app's step screen, checks that Fit shows every card, and a clicked",
      "card's details, inside the map's frame with the Manager open and closed, and runs the design probe.",
    ],
  },
  {
    phase: queueMapPhase,
    outputs: QUEUE_MAP_OUTPUTS,
    help: [
      "On the queue factory's map it times queue-run steps and `fixture:write attention`, opens each",
      `of its views (${QUEUE_MAP_VIEWS.map((v) => `\`?view=${v.id}\``).join(', ')}) with a screenshot and a design probe,`,
      "and follows App check's Behind the scenes check step, which must show the factory package",
      'prompt, with a design probe on each of the two package steps.',
    ],
  },
  {
    phase: boardPhase,
    outputs: BOARD_OUTPUTS,
    help: [
      'It checks the board, Pipeline and Table, against a recount of the seed, times `fixture:write label --label',
      'work-order:demo --issue <a card on the board>` to its panel, the same label on #4 (delivered',
      "by a merged pull request that says Refs) to that panel's merged count and a build step on the",
      "queue factory's work item 401 to its Build column, and checks `?order=demo`.",
    ],
  },
  {
    phase: workItemPhase,
    outputs: WORK_ITEM_OUTPUTS,
    help: [
      "It checks the work item page of the queue factory's returned-then-merged item 407 and of the",
      "seed's loop items against a recount, with no hidden check line or text on them, and times a",
      'build step on work item 401 to its running row.',
    ],
  },
  {
    phase: runsPhase,
    outputs: RUNS_OUTPUTS,
    help: [
      'It checks the runs screen against the seed (chips, first page, failed runs), turns an inserted idle',
      'poll through the toggle, and times the same `fixture:write step` events to their rows before and',
      'after the hold.',
    ],
  },
  {
    phase: oneLapPhase,
    outputs: ONE_LAP_OUTPUTS,
    help: [
      "It checks a gate-refused seed lap's page against SQL over the seed, with no holdout line or",
      "text on it, then times the first of those `fixture:write step` events to a running lap's page",
      'and one more on that lap after the hold.',
    ],
  },
  {
    phase: stepDetailPhase,
    outputs: STEP_DETAIL_OUTPUTS,
    help: [
      'It opens /f/<factory>/steps/archon-loop/check-app, checks it against the seed, times description writes to',
      'it across the same hold, and checks land, the way from deliver to the implement step it',
      "includes and that step's prompt, and an unknown step.",
    ],
  },
  {
    phase: attentionPhase,
    outputs: ATTENTION_OUTPUTS,
    help: [
      "It checks the attention page against the seed's open questions, owner items, stuck work and",
      'failure signatures, the head and the tab count against the cards shown, and times',
      '`fixture:write label` to it before and after the hold.',
    ],
  },
  {
    phase: managerPhase,
    outputs: MANAGER_OUTPUTS,
    help: [
      'It opens the Manager panel on /f/<factory>#manager and checks its head, its chip and the',
      "attention set's suggested questions against the page's count, waits for the day's briefing,",
      'follows the chip to Runs and to a run, asks the first suggested question there and checks',
      'every run id in the answer against the factory runs, and opens the Manager tab at 390. This',
      'asks the configured model one question, so it spends model budget.',
    ],
  },
  {
    phase: switcherPhase,
    outputs: SWITCHER_OUTPUTS,
    help: [
      'It checks the factory switcher: every factory in the factories file with its running laps, an',
      'inserted lap on the second factory timed to its count, choosing that factory from /, every',
      'factory screen and step detail, its map, strip and runs, and the remembered choice with its',
      'fallback for a removed factory; then, on a second server reading factories.json alone, that the',
      "switcher lists only factories.json's factories and the second factory is neither sealed for nor",
      'shown when remembered.',
    ],
  },
];

/** Every file test:live writes to --out: what --help names and what a run must have written. */
export const LIVE_OUTPUTS: readonly LiveOutput[] = SCREENS.flatMap((screen) => screen.outputs);

const WRAP = 100;

/** "  Writes a, b and c." wrapped at WRAP columns with a two-space indent. */
function writesLine(files: readonly string[]): string[] {
  const list =
    files.length < 2 ? files.join('') : `${files.slice(0, -1).join(', ')} and ${files.at(-1)}`;
  const lines: string[] = [];
  let line = '  Writes';
  for (const word of `${list}.`.split(' ')) {
    if (line.length + 1 + word.length > WRAP) {
      lines.push(line);
      line = `  ${word}`;
    } else {
      line += ` ${word}`;
    }
  }
  return [...lines, line];
}

const USAGE = [
  'usage: bun run test:live [--out <dir>] [--hold <seconds>]',
  '  Runs one at a time per machine: it takes a lock in the temp directory before serving and',
  '  measuring, waits up to 30 minutes for another running test:live (naming its process id),',
  '  takes over a lock whose process no longer exists, and releases it when it ends.',
  ...SCREENS.flatMap(({ help, outputs }) => [
    ...help.map((line) => `  ${line}`),
    ...writesLine(outputs),
  ]),
  '  Each `fixture:write` is timed from its exit, when its write has committed, to the screen.',
].join('\n');

/**
 * What a run wrote against what --help names: a file written but not named is always a failure;
 * a file named but not written is one only when the run otherwise passed, so a broken run reports
 * its real failure first.
 */
export function outputFailures(
  named: readonly string[],
  written: ReadonlySet<string>,
  passed: boolean,
): string[] {
  const failures = [...written]
    .filter((file) => !named.includes(file))
    .map(
      (file) =>
        `test:live wrote ${file}, which --help does not name: add it to its phase's outputs`,
    );
  if (passed) {
    failures.push(
      ...named
        .filter((file) => !written.has(file))
        .map((file) => `--help names ${file}, but no phase wrote it`),
    );
  }
  return failures;
}

const FEATURE_TIMEOUT_MS = 10_000;

export interface Feature {
  feature: string;
  probe: string;
  verdict: 'accepted' | 'rejected';
  error: string;
}

/** The probe table in REALTIME.md: one row per feature, the probe SQL in backticks. */
export function parseRealtimeFeatures(markdown: string): Feature[] {
  const rows = markdown.matchAll(
    /^\|\s*([^|]+?)\s*\|\s*`([^`]+)`\s*\|\s*(accepted|rejected)\s*\|\s*([^|]*?)\s*\|$/gm,
  );
  return [...rows].map(([, feature, probe, verdict, error]) => ({
    feature,
    probe,
    verdict: verdict as Feature['verdict'],
    error: error.trim(),
  }));
}

/** Bun's WebSocket takes headers (Realtime checks the origin) and wants protocols as a list. */
const BunWebSocket = WebSocket as unknown as new (
  url: string,
  options: { protocols: string[]; headers: Record<string, string> },
) => WebSocketLike;

/** Subscribes `probe` with `params` from this process as the browser would, and reports what Realtime said. */
async function runProbe(
  probe: string,
  params: string[],
  env: { databaseUrl: string; secret: string; origin: string },
): Promise<Pick<Feature, 'verdict' | 'error'>> {
  const sealer = createRealtime({
    // The app seals in safe mode, where a rejection reads `upstream rejected`; the table records why.
    debugMode: true,
    secret: env.secret,
    db: new URL(env.databaseUrl).pathname.slice(1),
  });
  const client = createRealtimeClient({
    url: realtimeUrlFor(env.databaseUrl),
    webSocketFactory: (url, protocols) =>
      new BunWebSocket(url, { protocols: [protocols].flat(), headers: { origin: env.origin } }),
  });
  try {
    const sealed = await sealer.seal({
      query: rawSql(probe, params),
    });
    const subscription = client.subscribe(sealed);
    return await new Promise((done) => {
      const timer = setTimeout(
        () => done({ verdict: 'rejected', error: 'no rows or error within 10s' }),
        FEATURE_TIMEOUT_MS,
      );
      subscription.onChange(({ status, data, error }) => {
        if (error) {
          clearTimeout(timer);
          done({ verdict: 'rejected', error: `${error.code}: ${error.message}` });
        } else if (status === 'live' && data !== undefined) {
          clearTimeout(timer);
          done({ verdict: 'accepted', error: '' });
        }
      });
    });
  } finally {
    client.close();
  }
}

async function testLive(deps: Deps, outDir: string, holdSeconds: number): Promise<void> {
  const databaseUrl = await guardedDatabaseUrl(deps, 'check');
  const homeBranch = await resolveBranchName(databaseUrl, deps.neon());
  const queries = loadLiveQueries(join(deps.repoRoot, 'db', 'queries'));
  const secret = deps.env.NEON_REALTIME_SECRET;
  if (!secret) throw new Error('NEON_REALTIME_SECRET is not set: run `bun run fixture:branch`');
  const { factories } = JSON.parse(readFileSync(join(deps.repoRoot, 'factories.json'), 'utf-8'));
  const factory: string = factories[0].name;
  mkdirSync(outDir, { recursive: true });
  // The seed's second and queue factories are in mc.factories only; the app shows each once its file names it.
  const factoriesFile = join(outDir, RUNNER_FILES.factories);
  const outputsWritten = new Set<string>([RUNNER_FILES.factories]);
  writeFileSync(
    factoriesFile,
    `${JSON.stringify({ factories: [...factories, SECOND_FACTORY, QUEUE_FACTORY] }, null, 2)}
`,
  );

  const db = deps.openDb(databaseUrl);
  const timingDatabase = { db, branch: homeBranch, selectedBranch: null };
  /** Laps `fixture:write` started LIVE_STEP on; the cleanup removes those events and steps. */
  const written: string[] = [];
  const failures: string[] = [];
  const ctx: LiveContext = {
    deps,
    db,
    factory,
    factoriesFile,
    holdSeconds,
    homeBranch,
    queries,
    branch: deps.env.MC_CHECK_BRANCH ?? null,
    timingDatabase,
    measure: (page, names) =>
      measurePanels(page, names, timingDatabase, queries, factory, READY_WAIT_MS),
    save(file, data) {
      outputsWritten.add(file);
      writeFileSync(join(outDir, file), data);
    },
    designProbe(url, file, on) {
      outputsWritten.add(file);
      const probe = Bun.spawnSync(
        ['bun', 'harness/design-probe.js', url, '--out', join(outDir, file)],
        { cwd: deps.repoRoot, env: deps.env, stdout: 'ignore', stderr: 'inherit' },
      );
      if (probe.exitCode !== 0) {
        failures.push(`the design probe${on ? ` on ${on}` : ''} exited ${probe.exitCode}`);
      }
    },
    port: null,
    base: '',
    laps: ['', ''],
    async lapStep(run, afterHold) {
      for (const phase of phases) await phase.beforeLapStep?.(afterHold);
      written.push(run);
      await fixtureWrite(deps, [
        'step',
        '--run',
        run,
        '--step',
        LIVE_STEP,
        '--event',
        'node_started',
      ]);
      await Promise.all(phases.map((phase) => phase.onLapStep?.(run, afterHold)));
    },
    inserted: [],
    failures,
  };
  const phases = SCREENS.flatMap(({ phase }) => (phase ? [phase(ctx)] : []));
  let server: ReturnType<typeof Bun.spawn> | undefined;
  try {
    const setup = Bun.spawnSync(['bun', 'run', 'setup'], {
      cwd: deps.repoRoot,
      stdout: 'ignore',
      stderr: 'inherit',
    });
    if (setup.exitCode !== 0) throw new Error(`bun run setup exited ${setup.exitCode}`);

    const port = await freePort(deps);
    ctx.port = port;
    const base = `http://localhost:${port}`;
    ctx.base = base;
    const proc = Bun.spawn(['bun', 'server/main.ts', '--port', String(port)], {
      cwd: deps.repoRoot,
      env: { ...deps.env, MC_FACTORIES_FILE: factoriesFile },
      stdout: 'ignore',
      stderr: 'inherit',
    });
    server = proc;
    await waitForHealth(base, () => proc.exitCode !== null);

    const documented = parseRealtimeFeatures(
      readFileSync(join(deps.repoRoot, 'db', 'queries', 'REALTIME.md'), 'utf-8'),
    );
    const features: Feature[] = [];
    for (const row of documented) {
      const seen = await runProbe(row.probe, row.probe.includes('$1') ? [factory] : [], {
        databaseUrl,
        secret,
        origin: base,
      });
      features.push({ ...row, ...seen });
      if (seen.verdict !== row.verdict || seen.error !== row.error) {
        failures.push(
          `REALTIME.md says ${row.feature} is ${row.verdict}${row.error ? ` (${row.error})` : ''}; Realtime said ${seen.verdict}${seen.error ? ` (${seen.error})` : ''}`,
        );
      }
    }
    ctx.save(
      RUNNER_FILES.features,
      `${JSON.stringify({ branch: ctx.branch, features }, null, 2)}\n`,
    );

    // Every file the app seals, with the factory and a value of the right type for each further
    // parameter: text, or an instant or a count where the query casts it. A query Realtime refuses
    // fails here, by name.
    const EPOCH = '1970-01-01T00:00:00Z';
    const typedArgs: Record<string, string[]> = {
      'factory-scorecard': [EPOCH, EPOCH, EPOCH, EPOCH, EPOCH],
      'failure-groups': [EPOCH],
      'retried-runs': [EPOCH],
      runs: ['', '', 'show', '0', '1'],
    };
    for (const [name, sql] of queries) {
      const params = [
        factory,
        ...(typedArgs[name] ?? Array(Math.max(0, parameterCount(sql) - 1)).fill('')),
      ];
      const seen = await runProbe(sql, params, { databaseUrl, secret, origin: base });
      if (seen.verdict === 'rejected') {
        failures.push(`Realtime refuses db/queries/${name}.sql (${seen.error})`);
      }
    }

    const laps = await db.query(
      `SELECT l.run_id FROM mc.laps l
        WHERE l.factory = $1 AND l.workflow_name = 'archon-loop' AND l.status = 'running'
          AND NOT EXISTS (SELECT 1 FROM mc.lap_steps ls
                           WHERE ls.run_id = l.run_id AND ls.step_id = $2)
        ORDER BY l.run_id LIMIT 2`,
      [factory, LIVE_STEP],
    );
    if (laps.length < 2) throw new Error(`the check branch has ${laps.length} running laps, not 2`);
    const [firstLap, secondLap] = laps.map((l) => String(l.run_id));
    ctx.laps = [firstLap, secondLap];

    for (const phase of phases) await phase.open?.();
    for (const phase of phases) await phase.write?.();
    for (const phase of phases) await phase.beforeHold?.();
    deps.out(`holding the page open ${holdSeconds}s`);
    await deps.sleep(holdSeconds * 1000);
    for (const phase of phases) await phase.writeAgain?.();
    for (const phase of phases) await phase.afterHold?.();
    for (const phase of phases) await phase.probe?.(ctx.designProbe);
  } finally {
    // The pages and the server go first, so a failed cleanup below cannot leave them running.
    for (const phase of phases) await phase.close?.();
    if (server) {
      server.kill();
      await server.exited;
    }
    try {
      const { inserted } = ctx;
      if (inserted.length > 0) {
        await db.query('DELETE FROM mc.laps WHERE run_id = ANY($1::uuid[])', [
          `{${inserted.join(',')}}`,
        ]);
      }
      if (written.length > 0) {
        const runs = `{${written.join(',')}}`;
        await db.query(
          'DELETE FROM remote_agent_workflow_events WHERE workflow_run_id = ANY($1::uuid[]) AND step_name = $2',
          [runs, LIVE_STEP],
        );
        await db.query('DELETE FROM mc.lap_steps WHERE run_id = ANY($1::uuid[]) AND step_id = $2', [
          runs,
          LIVE_STEP,
        ]);
      }
    } catch (err) {
      failures.push(`removing the inserted rows failed: ${(err as Error).message}`);
    }
    try {
      for (const phase of phases) failures.push(...((await phase.cleanup?.()) ?? []));
    } finally {
      await db.close();
    }
  }

  for (const phase of phases) failures.push(...(phase.judge?.() ?? []));
  failures.push(...outputFailures(LIVE_OUTPUTS, outputsWritten, failures.length === 0));
  if (failures.length > 0) throw new Error(failures.join('\n'));
  for (const phase of phases) for (const line of phase.summary?.() ?? []) deps.out(line);
}

export const main: Main = async (argv, deps) => {
  let values: { out?: string; hold?: string; help?: boolean };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        out: { type: 'string' },
        hold: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    }));
  } catch (error) {
    deps.err(`${error instanceof Error ? error.message : error}\n${USAGE}`);
    return 2;
  }
  if (values.help) {
    deps.out(USAGE);
    return 0;
  }
  const hold = Number(values.hold ?? 180);
  if (!Number.isInteger(hold) || hold < 0) {
    deps.err(`--hold takes whole seconds\n${USAGE}`);
    return 2;
  }
  const outDir = resolve(values.out ?? join(deps.repoRoot, 'harness', '.results', 'live'));
  return failing(deps, () =>
    withMachineLock(deps, machineLockPath(deps), () => testLive(deps, outDir, hold)),
  );
};

if (import.meta.main) await runCli(main);
