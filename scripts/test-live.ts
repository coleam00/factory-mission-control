// Each screen's test:live phase is one module under scripts/live/ returning a LivePhase; adding a
// screen is one new module and one line in `phases` in testLive. Helpers two modules use live in
// scripts/live/shared.ts.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createRealtimeClient, type WebSocketLike } from '@neon/realtime/client';
import { createRealtime, rawSql } from '@neon/realtime/server';
import { loadLiveQueries, realtimeUrlFor } from '../server/live';
import { SECOND_FACTORY } from './fixture/seed';
import { type Deps, failing, guardedDatabaseUrl, type Main, runCli } from './lib/cli';
import { machineLockPath, withMachineLock } from './lib/machine-lock';
import { resolveBranchName } from './lib/target';
import { decisionsPhase } from './live/decisions';
import { diffPhase } from './live/diff';
import { healthPhase } from './live/health';
import { homePhase } from './live/home';
import { issuesPhase } from './live/issues';
import { lapsPhase } from './live/laps';
import { oneLapPhase } from './live/one-lap';
import { ownerPhase } from './live/owner';
import { rewindPhase } from './live/rewind';
import { scorecardPhase } from './live/scorecard';
import {
  type DesignProbe,
  fixtureWrite,
  freePort,
  LIVE_STEP,
  type LiveContext,
  type LivePhase,
  READY_WAIT_MS,
  waitForHealth,
} from './live/shared';
import { stepDetailPhase } from './live/step-detail';
import { switcherPhase } from './live/switcher';
import { measurePanels } from './live/timings';
import { versionsPhase } from './live/versions';

const USAGE = [
  'usage: bun run test:live [--out <dir>] [--hold <seconds>]',
  '  Runs one at a time per machine: it takes a lock in the temp directory before serving and',
  '  measuring, waits up to 30 minutes for another running test:live (naming its process id),',
  '  takes over a lock whose process no longer exists, and releases it when it ends.',
  '  Proves the home screen is live against the check branch in .mc-check.env (run',
  '  `bun run fixture:branch` first): serves the app on a free port in 8850-8864 (waiting up to 30',
  '  minutes while every one is taken), opens `/` in a headless browser, checks the map against the',
  '  seed, times inserted laps to the factory strip',
  '  and `fixture:write step` events to the map, holds the page open --hold seconds (default 180)',
  '  across seal renewals, clicks a step, re-runs the probes in db/queries/REALTIME.md, and runs',
  '  the design probe. Writes realtime-timings.json, realtime-features.json, home-map-timings.json,',
  '  home-map.png and home-map-design-probe.json to --out (default harness/.results/live).',
  '  On the same run it checks the versions screen against the seed, picks two versions, and times',
  '  `fixture:write pin` to that screen before and after the hold, writing version-strip-check.txt,',
  '  version-strip-timings.json, version-strip.png and version-strip-design-probe.json.',
  '  It then opens the scorecard of V1 against V2 and of V1 against V3, checks every number against',
  '  fixtures/expected-scorecard.json and the not-yet-meaningful labels, and times',
  '  `fixture:write step --step land` on a V2 lap to the screen before and after the hold, writing',
  '  scorecard-vs-expected.json, scorecard-timings.json, scorecard.png and',
  "  scorecard-design-probe.json; it restores those laps' land steps afterwards.",
  '  It checks the decisions screen against the seed, times `fixture:write verdict --pin <V2>` and',
  '  `fixture:write decision` to that screen before and after the hold, writing ledger-check.txt,',
  '  decisions-ledger-timings.json, decisions-ledger.png and decisions-ledger-design-probe.json.',
  "  It checks the owner queue against the seed's open needs-owner issues and open owner questions,",
  '  and times `fixture:write label` to it before and after the hold, writing owner-queue-check.txt,',
  '  owner-queue-timings.json, owner-queue.png and owner-queue-design-probe.json.',
  '  It checks the issues screen against the seed and times `fixture:write label` to it before and',
  '  after the hold, writing issue-graph-check.txt, phases-issue-graph-timings.json,',
  '  phases-issue-graph.png and phases-issue-graph-design-probe.json.',
  '  It checks the health screen against SQL over the seed and times `fixture:write step --event',
  '  node_failed --error ECONNRESET` on each running lap to its infrastructure count, one before and',
  '  one after the hold, writing health-check.txt, health-timings.json, health.png and',
  '  health-design-probe.json.',
  '  It checks the laps screen against the seed and times the same `fixture:write step` events to',
  '  their lanes before and after the hold, writing lanes-check.txt, lanes-recent-laps-timings.json,',
  '  lanes-recent-laps.png and lanes-recent-laps-design-probe.json.',
  "  It checks a gate-refused seed lap's page against SQL over the seed, with no holdout text on",
  "  it, then times the first of those `fixture:write step` events to a running lap's page and",
  '  one more on that lap after the hold, writing one-lap-check.txt, one-lap-timings.json,',
  '  one-lap.png, one-lap-design-probe.json and one-lap-refused-design-probe.json.',
  "  Then it opens the diff of the two versions, checks it lists exactly the seed's scripted change,",
  '  and times a step inserted into the second version to that screen before and after the hold,',
  '  writing arch-diff-timings.json, arch-diff.png and arch-diff-design-probe.json.',
  '  It opens /steps/archon-loop/check-app, checks it against the seed, times description writes to',
  '  it across the same hold, and checks land, the way from deliver to the implement step it',
  "  includes and that step's prompt, and an unknown step, writing",
  '  step-detail-timings.json, step-detail.png and step-detail-design-probe.json.',
  '  It opens /rewind on a second server, which must refuse a switch to an unlisted rewind-* name,',
  '  makes a rewind branch of the check branch with `bun run rewind:create` before the hold and',
  '  another after it, switches to the first and back, and a second page left open on / must',
  '  follow each switch by itself within 55 s; that page then switches to the second, opens Issues',
  '  and must come back to Issues, live, from its Switch back, writing rewind-run.txt, rewind-timings.json, rewind.png and rewind-design-probe.json.',
  "  Its server reads factories.json plus the seed's second factory (factories.json in --out, as",
  '  MC_FACTORIES_FILE). Before the diff it checks the factory switcher: every factory in that file',
  '  with its running laps, an inserted lap on the second factory timed to its count, choosing that',
  '  factory from /, every factory screen and step detail, its map, strip and lanes, and the',
  '  remembered choice with its fallback for a removed factory; then, on a second server reading',
  "  factories.json alone, that the switcher lists only factories.json's factories and the second",
  '  factory is neither sealed for nor shown when remembered. It writes switcher-check.txt,',
  '  switcher-timings.json, switcher.png and switcher-design-probe.json.',
  '  Each `fixture:write` is timed from its exit, when its write has committed, to the screen.',
].join('\n');

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

/** Subscribes `probe` from this process as the browser would, and reports what Realtime said. */
async function runProbe(
  probe: string,
  factory: string,
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
      query: rawSql(probe, probe.includes('$1') ? [factory] : []),
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
  // The seed's second factory is in mc.factories only; the app shows it once its file names it.
  const factoriesFile = join(outDir, 'factories.json');
  writeFileSync(
    factoriesFile,
    `${JSON.stringify({ factories: [...factories, SECOND_FACTORY] }, null, 2)}
`,
  );

  const db = deps.openDb(databaseUrl);
  const timingDatabase = { db, branch: homeBranch, selectedBranch: null };
  /** Laps `fixture:write` started LIVE_STEP on; the cleanup removes those events and steps. */
  const written: string[] = [];
  const ctx: LiveContext = {
    deps,
    db,
    outDir,
    factory,
    factoriesFile,
    holdSeconds,
    homeBranch,
    queries,
    branch: deps.env.MC_CHECK_BRANCH ?? null,
    timingDatabase,
    measure: (page, names) =>
      measurePanels(page, names, timingDatabase, queries, factory, READY_WAIT_MS),
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
    failures: [],
  };
  const { failures } = ctx;
  const rewind = rewindPhase(ctx);
  // The order is the order of every write against every read that judges it: the laps screen
  // and the lap open before the strip's first insert, the decisions screen writes before the
  // step, versions and scorecard screens open and judges the versions screen's pin after the
  // hold, and the switcher runs before the diff adds steps to the architecture the second
  // factory's map shows. The owner queue labels just before the issues screen does, so each of the
  // issues screen's labels lands on a waiting issue. Rewind is last: making a rewind branch starts a new Neon compute on the
  // project, so every other screen's first snapshots are timed before it.
  const phases: LivePhase[] = [
    homePhase(ctx),
    lapsPhase(ctx),
    oneLapPhase(ctx),
    decisionsPhase(ctx),
    stepDetailPhase(ctx),
    versionsPhase(ctx),
    scorecardPhase(ctx),
    ownerPhase(ctx),
    issuesPhase(ctx),
    healthPhase(ctx),
    switcherPhase(ctx),
    diffPhase(ctx),
    { ...rewind, summary: () => [`rewind: ${JSON.stringify(rewind.timings)}`] },
  ];
  const designProbe: DesignProbe = (url, file, on) => {
    const probe = Bun.spawnSync(
      ['bun', 'harness/design-probe.js', url, '--out', join(outDir, file)],
      { cwd: deps.repoRoot, env: deps.env, stdout: 'ignore', stderr: 'inherit' },
    );
    if (probe.exitCode !== 0) {
      failures.push(`the design probe${on ? ` on ${on}` : ''} exited ${probe.exitCode}`);
    }
  };
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
      const seen = await runProbe(row.probe, factory, { databaseUrl, secret, origin: base });
      features.push({ ...row, ...seen });
      if (seen.verdict !== row.verdict || seen.error !== row.error) {
        failures.push(
          `REALTIME.md says ${row.feature} is ${row.verdict}${row.error ? ` (${row.error})` : ''}; Realtime said ${seen.verdict}${seen.error ? ` (${seen.error})` : ''}`,
        );
      }
    }
    writeFileSync(
      join(outDir, 'realtime-features.json'),
      `${JSON.stringify({ branch: ctx.branch, features }, null, 2)}\n`,
    );

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
    for (const phase of phases) await phase.probe?.(designProbe);
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
