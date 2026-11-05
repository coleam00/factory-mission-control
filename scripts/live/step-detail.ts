import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openPage, type Page } from '../lib/cdp';
import type { Db } from '../lib/db';
import {
  LIMITS,
  type LiveContext,
  type LivePhase,
  lateWrite,
  pageWait,
  READY_WAIT_MS,
  RENEWALS_IN_180S,
  required,
} from './shared';
import {
  emptyGroupTimings,
  type GroupTimings,
  groupPerformanceFailures,
  groupTimings,
  readyFailures,
} from './timings';

/** Every live query the step screen reads, one panel each. */
const STEP_QUERIES = [
  'step-detail',
  'step-nesting',
  'step-prompt',
  'step-subagents',
  'step-scripts',
  'step-yaml',
  'step-versions',
];
const STEP_PATH = '/steps/archon-loop/check-app';
/**
 * The step deliver's block includes to write the code, and the prompt the seed pins for it. Its
 * declaring address redirects to the first place deliver runs it at.
 */
const IMPLEMENT_PATH = '/steps/archon-implement/implement';
const DELIVER_PLACE = '/steps/archon-loop/ship%2Fdeliver';
const IMPLEMENT_PLACE = `${DELIVER_PLACE}%2Frounds%2Fimplement%2Fimplement`;
const RESHAPE_PLACE = `${DELIVER_PLACE}%2Frounds%2Freshape%2Fimplement`;
const IMPLEMENT_PROMPT = 'fixtures/pack/sdlc/implement/commands/implement.md';
/** A step whose prompt the seed changes between its two versions with architecture. */
const REVIEW_PATH = '/steps/archon-loop/review';
const REVIEW_PROMPT = 'loop/commands/loop-review.md';
/**
 * check-app at the seed's current version, V2 (the newest pin with architecture rows): V2 drops
 * `briefs`, so it depends on `subject` alone (owner decision on #14).
 */
const SEED_CHECK_APP = {
  prompt: 'fixtures/pack/sdlc/loop/commands/loop-check-app.md',
  hiddenSubagent: 'holdout-verifier',
  dependsOn: 'subject',
};

interface StepTimings extends GroupTimings {
  branch: string | null;
  port: number | null;
  descriptionToScreenMs: number | null;
  holdSeconds: number;
  renewals: number | null;
  afterHoldDescriptionToScreenMs: number | null;
  noReload: boolean | null;
  limits: typeof LIMITS;
}

interface Version {
  archon_sha: string;
  factory_sha: string;
}

/**
 * The architecture key of the seed's current version, as the step queries choose it for
 * mission-control, a factory on the queues (#435): the architecture parsed last.
 */
async function currentVersion(db: Db): Promise<Version> {
  const [version] = await db.query(
    'SELECT a.archon_sha, a.factory_sha FROM mc.arch_versions a ORDER BY a.parsed_at DESC LIMIT 1',
  );
  if (!version) throw new Error('the check branch has no architecture rows');
  return version as unknown as Version;
}

const stepPanelsReady = `document.querySelectorAll('${STEP_QUERIES.map((q) => `[data-live="${q}"][data-state="ready"]`).join(', ')}').length === ${STEP_QUERIES.length}`;

/** Where check-app's screen differs from the seed: one line each. */
async function checkAppMismatches(page: Page, repoRoot: string): Promise<string[]> {
  const shown = await page.evaluate<{
    prompt: string | null;
    subagent: boolean;
    dependsOn: string | null;
  }>(`({
    prompt: document.querySelector('[data-live="step-prompt"] [data-prompt]')?.textContent ?? null,
    subagent: document.querySelector('[data-live="step-subagents"] [data-subagent="${SEED_CHECK_APP.hiddenSubagent}"]') !== null,
    dependsOn: document.querySelector('[data-depends-on]')?.getAttribute('data-depends-on') ?? null,
  })`);
  const failures: string[] = [];
  if (shown.prompt !== readFileSync(join(repoRoot, SEED_CHECK_APP.prompt), 'utf-8')) {
    failures.push(`check-app's prompt is not ${SEED_CHECK_APP.prompt} byte for byte`);
  }
  if (shown.subagent)
    failures.push(`check-app lists the subagent ${SEED_CHECK_APP.hiddenSubagent}`);
  if (shown.dependsOn !== SEED_CHECK_APP.dependsOn) {
    failures.push(`check-app depends on "${shown.dependsOn}", not "${SEED_CHECK_APP.dependsOn}"`);
  }
  return failures;
}

/** Ready once the browser is at `path` (the address a redirect ends at) and every panel answered. */
const readyAt = (path: string) => `location.pathname === '${path}' && ${stepPanelsReady}`;

/**
 * Where the way from deliver's screen to the step that writes the code differs from the seed:
 * deliver's shared address opens its first place, both places deliver runs the step at open their
 * own screen, and the step's declaring address opens the first of them, showing its pinned prompt.
 */
async function includedImplementMismatches(
  page: Page,
  base: string,
  repoRoot: string,
): Promise<string[]> {
  const failures: string[] = [];
  await openStep(page, base, '/steps/archon-ship-block/deliver', readyAt(DELIVER_PLACE));
  const places: [string, string][] = [
    ['rounds/implement/implement', IMPLEMENT_PLACE],
    ['rounds/reshape/implement', RESHAPE_PLACE],
  ];
  for (const [label, place] of places) {
    const href = await page.evaluate<string | null>(
      `document.querySelector('[data-live="step-nesting"] [data-inside="${label}"] a')?.getAttribute('href') ?? null`,
    );
    if (href !== place) failures.push(`deliver's ${label} opens ${href}, not ${place}`);
  }
  await openStep(page, base, IMPLEMENT_PATH, readyAt(IMPLEMENT_PLACE));
  const prompt = await page.evaluate<string | null>(
    `document.querySelector('[data-live="step-prompt"] [data-prompt]')?.textContent ?? null`,
  );
  if (prompt !== readFileSync(join(repoRoot, IMPLEMENT_PROMPT), 'utf-8')) {
    failures.push(`${IMPLEMENT_PATH}'s prompt is not ${IMPLEMENT_PROMPT} byte for byte`);
  }
  return failures;
}

/** The stored review prompt at a version's architecture. */
async function reviewPromptAt(db: Db, version: Version): Promise<string | null> {
  const [row] = await db.query(
    'SELECT text FROM mc.arch_texts WHERE archon_sha = $1 AND factory_sha = $2 AND path = $3',
    [version.archon_sha, version.factory_sha, REVIEW_PROMPT],
  );
  return typeof row?.text === 'string' ? row.text : null;
}

const isOneSentence = (text: string) => text.match(/[.!?](\s|$)/g)?.length === 1;

const onVersionPicker = `document.querySelector('[data-step-version]') !== null`;

/**
 * Where the step screen at an older version differs from what that version stored: review opened
 * at the older pin shows its own prompt, not the current one, and a version nobody recorded reads
 * one sentence. Both keep the version picker.
 */
async function olderVersionMismatches(page: Page, base: string, db: Db): Promise<string[]> {
  const failures: string[] = [];
  const pins = (await db.query(
    `SELECT p.sha, a.archon_sha, a.factory_sha FROM mc.arch_versions a
       JOIN mc.pins p ON p.archon_sha = a.archon_sha
      ORDER BY p.committed_at DESC, a.parsed_at DESC`,
  )) as unknown as (Version & { sha: string })[];
  const [current] = pins;
  const older = pins.find((pin) => pin.sha !== current?.sha);
  if (!current || !older) return ['the check branch has no older pin with architecture rows'];
  const olderPrompt = await reviewPromptAt(db, older);
  if (olderPrompt === null || olderPrompt === (await reviewPromptAt(db, current))) {
    return [`the seed's review prompt does not differ at ${older.sha.slice(0, 8)}`];
  }
  await openStep(page, base, `${REVIEW_PATH}?at=${older.sha}`, stepPanelsReady);
  const prompt = await page.evaluate<string | null>(
    `document.querySelector('[data-live="step-prompt"] [data-prompt]')?.textContent ?? null`,
  );
  if (prompt !== olderPrompt) {
    failures.push(`review at ${older.sha.slice(0, 8)} does not show that version's prompt`);
  }
  if (!(await page.evaluate<boolean>(onVersionPicker))) {
    failures.push(`review at ${older.sha.slice(0, 8)} shows no version picker`);
  }
  await openStep(
    page,
    base,
    `${REVIEW_PATH}?at=not-a-version`,
    `document.querySelector('[data-live="step-detail"][data-state="ready"]') !== null`,
  );
  const unknown = await page.evaluate<string>(
    `document.querySelector('[data-live="step-detail"]').textContent.trim()`,
  );
  if (!isOneSentence(unknown)) {
    failures.push(`an unknown version shows "${unknown}", not one sentence`);
  }
  if (!(await page.evaluate<boolean>(onVersionPicker))) {
    failures.push('an unknown version shows no version picker');
  }
  return failures;
}

const setCheckAppDescription = `UPDATE mc.arch_steps SET description = $3
  WHERE archon_sha = $1 AND factory_sha = $2 AND workflow = 'archon-loop' AND path = 'check-app'`;

/** Writes check-app's stored description and times it from just before the write to the screen. */
async function descriptionToScreen(page: Page, db: Db, version: Version): Promise<number | null> {
  const text = `test:live ${crypto.randomUUID()}`;
  const started = performance.now();
  const shown = page.evaluate<boolean>(
    pageWait(
      `document.querySelector('[data-description]')?.textContent === '${text}'`,
      LIMITS.insertToScreenMs,
    ),
    LIMITS.insertToScreenMs + 5000,
  );
  await db.query(setCheckAppDescription, [version.archon_sha, version.factory_sha, text]);
  return (await shown) ? Math.round(performance.now() - started) : null;
}

/** Opens `path` on the app and waits until `ready` holds in the page. */
async function openStep(page: Page, base: string, path: string, ready: string): Promise<void> {
  await page.goto(`${base}${path}`);
  if (!(await page.evaluate<boolean>(pageWait(ready, READY_WAIT_MS)))) {
    throw new Error(`${path} did not reach data-state="ready" within ${READY_WAIT_MS} ms`);
  }
}

/**
 * The step screen on check-app: the seed's step, description writes timed to it across the hold,
 * then land, the way from deliver to the implement step it includes, review at an older version
 * and at an unknown one, and an unknown step.
 */
export function stepDetailPhase(ctx: LiveContext): LivePhase {
  const { deps, db, outDir, holdSeconds, branch, measure } = ctx;
  const stepTimings: StepTimings = {
    branch,
    port: null,
    ...emptyGroupTimings(STEP_QUERIES),
    descriptionToScreenMs: null,
    holdSeconds,
    renewals: null,
    afterHoldDescriptionToScreenMs: null,
    noReload: null,
    limits: LIMITS,
  };
  /** check-app's description before test:live wrote it, restored at the end. */
  let described: { version: Version; was: unknown } | undefined;
  let stepPage: Page | undefined;

  return {
    async write() {
      const { base } = ctx;
      const page = await openPage(deps.env);
      stepPage = page;
      await openStep(page, base, STEP_PATH, stepPanelsReady);
      await page.evaluate('window.__mcNoReload = true');
      Object.assign(stepTimings, groupTimings(await measure(page, STEP_QUERIES)));
      ctx.failures.push(...(await checkAppMismatches(page, deps.repoRoot)));
      writeFileSync(join(outDir, 'step-detail.png'), await page.screenshot(1440));
    },

    // check-app's description is written only once every phase has written: it is in V2's
    // architecture, so the diff screen would list it as changed.
    async beforeHold() {
      const version = await currentVersion(db);
      const [checkApp] = await db.query(
        `SELECT description FROM mc.arch_steps
          WHERE archon_sha = $1 AND factory_sha = $2 AND workflow = 'archon-loop' AND path = 'check-app'`,
        [version.archon_sha, version.factory_sha],
      );
      described = { version, was: checkApp?.description ?? null };
      stepTimings.descriptionToScreenMs = await descriptionToScreen(
        required(stepPage, 'step page'),
        db,
        version,
      );
      deps.out(
        `first description write reached the step in ${stepTimings.descriptionToScreenMs ?? 'never'} ms`,
      );
    },

    async writeAgain() {
      const { base } = ctx;
      const page = required(stepPage, 'step page');
      const { version } = required(described, "check-app's description");
      stepTimings.renewals = await page.evaluate<number>(
        `performance.getEntriesByName('live:step-detail:renewed').length`,
      );
      stepTimings.afterHoldDescriptionToScreenMs = await descriptionToScreen(page, db, version);
      stepTimings.noReload = await page.evaluate<boolean>('window.__mcNoReload === true');

      await openStep(page, base, '/steps/archon-loop/land', stepPanelsReady);
      const [land] = await db.query(
        `SELECT when_condition FROM mc.arch_steps
          WHERE archon_sha = $1 AND factory_sha = $2 AND workflow = 'archon-loop' AND path = 'land'`,
        [version.archon_sha, version.factory_sha],
      );
      const when = await page.evaluate<string | null>(
        `document.querySelector('[data-when]')?.textContent ?? null`,
      );
      if (typeof land?.when_condition !== 'string' || when !== land.when_condition) {
        ctx.failures.push(`land shows when "${when}", stored "${land?.when_condition}"`);
      }
      ctx.failures.push(...(await includedImplementMismatches(page, base, deps.repoRoot)));
      ctx.failures.push(...(await olderVersionMismatches(page, base, db)));
      await openStep(
        page,
        base,
        '/steps/archon-loop/no-such-step',
        `document.querySelector('[data-live="step-detail"][data-state="ready"]') !== null`,
      );
      const unknown = await page.evaluate<string>(
        `document.querySelector('[data-live="step-detail"]').textContent.trim()`,
      );
      if (!isOneSentence(unknown)) {
        ctx.failures.push(`an unknown step shows "${unknown}", not one sentence`);
      }
      await page.close();
      stepPage = undefined;
    },

    async probe(designProbe) {
      const { base } = ctx;
      designProbe(`${base}${STEP_PATH}`, 'step-detail-design-probe.json', STEP_PATH);
    },

    async close() {
      stepTimings.port = ctx.port;
      writeFileSync(
        join(outDir, 'step-detail-timings.json'),
        `${JSON.stringify(stepTimings, null, 2)}\n`,
      );
      await stepPage?.close().catch(() => undefined);
    },

    async cleanup() {
      try {
        if (described) {
          const { version, was } = described;
          await db.query(setCheckAppDescription, [version.archon_sha, version.factory_sha, was]);
        }
        return [];
      } catch (err) {
        return [`restoring check-app's description failed: ${(err as Error).message}`];
      }
    },

    judge() {
      const failures: string[] = [];
      failures.push(...readyFailures('the step screen', stepTimings, LIMITS.readyMs));
      failures.push(...groupPerformanceFailures(STEP_QUERIES, stepTimings));
      failures.push(
        ...lateWrite('the first description write', 'the step', stepTimings.descriptionToScreenMs),
      );
      failures.push(
        ...lateWrite(
          `the description write after ${holdSeconds}s`,
          'the step',
          stepTimings.afterHoldDescriptionToScreenMs,
        ),
      );
      if (holdSeconds >= 180 && (stepTimings.renewals ?? 0) < RENEWALS_IN_180S) {
        failures.push(
          `${stepTimings.renewals} step-detail seal renewals in ${holdSeconds}s, expected at least ${RENEWALS_IN_180S}`,
        );
      }
      if (stepTimings.noReload !== true) failures.push('the step screen reloaded');
      return failures;
    },

    summary: () => [`step detail: ${JSON.stringify(stepTimings)}`],
  };
}
