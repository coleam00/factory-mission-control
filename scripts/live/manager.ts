import { openPage, type Page } from '../lib/cdp';
import { headCount } from './attention';
import {
  type LiveContext,
  type LiveOutput,
  type LivePhase,
  liveOutputs,
  pageWait,
  RUN_ROW,
  screenAgainstSql,
} from './shared';

const PANEL_WAIT_MS = 180_000;
const ATTENTION_QUESTIONS = ['What failed overnight?', 'What did today cost?', 'What is stuck?'];

const FILES = liveOutputs({
  check: 'manager-check.txt',
  shot: 'manager.png',
  run: 'manager-run.png',
  phone: 'manager-390.png',
  probe: 'manager-design-probe.json',
});
export const MANAGER_OUTPUTS: readonly LiveOutput[] = Object.values(FILES);

/** What the open panel shows. */
export interface ShownPanel {
  head: string;
  placeholder: string | null;
  chip: string | null;
  suggestions: string[];
}

/** The panel's chip, head, input and suggestions against what the design and the page's count bind. */
export function panelMismatches(
  shown: ShownPanel,
  attentionCount: number | null,
  expectedChip: string,
  expectedQuestions: readonly string[],
): string[] {
  const mismatches: string[] = [];
  const same = screenAgainstSql(mismatches);
  for (const text of ['Manager', 'Watches every run and queue for you']) {
    if (!shown.head.includes(text)) mismatches.push(`the head does not say "${text}"`);
  }
  same('placeholder', shown.placeholder, 'Ask about any run, or tell me what to do');
  same(
    'chip',
    shown.chip,
    attentionCount === null
      ? expectedChip
      : `${expectedChip} · ${attentionCount} ${attentionCount === 1 ? 'item' : 'items'}`,
  );
  same('suggestions', shown.suggestions, expectedQuestions);
  return mismatches;
}

/** Every run id the answer showed must be a run of the factory: a made-up id is a failure. */
export function answerMismatches(shown: readonly string[], known: ReadonlySet<string>): string[] {
  if (shown.length === 0) return ['the answer named no run'];
  return shown
    .filter((id) => !known.has(id))
    .map((id) => `the answer names run ${id}, which is not a run of the factory`);
}

const panelOnScreen = `(() => ({
  head: document.querySelector('aside[data-manager] > div')?.textContent ?? '',
  placeholder: document.querySelector('aside[data-manager] textarea')?.getAttribute('placeholder') ?? null,
  chip: document.querySelector('aside[data-manager] [data-manager-context] span')?.textContent ?? null,
  suggestions: [...document.querySelectorAll('aside[data-manager] [data-suggestion]')].map((b) => b.textContent),
}))()`;

/** The phone Manager tab fills the viewport exactly: the page does not scroll and the input ends above the tab bar. */
const phoneFit = `(() => {
  const input = document.querySelector('aside[data-manager="tab"] textarea')?.getBoundingClientRect();
  const bar = document.querySelector('nav[aria-label="Places"]')?.getBoundingClientRect();
  return {
    scrolls: document.documentElement.scrollHeight > window.innerHeight,
    inputAboveBar: input !== undefined && bar !== undefined && input.bottom <= bar.top,
  };
})()`;

/**
 * A reloaded page holds no answers, and a column shorter than the viewport lays out the same under
 * `h-screen` and `min-h-screen`. Fill the conversation scroller past its height so the fit
 * measurement can tell them apart; reports whether the scroller now overflows.
 */
const overflowConversation = `(() => {
  const scroller = document.querySelector('aside[data-manager="tab"] [data-manager-context]')?.parentElement;
  if (!scroller) return false;
  const filler = document.createElement('div');
  filler.style.height = window.innerHeight * 2 + 'px';
  scroller.appendChild(filler);
  return scroller.scrollHeight > scroller.clientHeight;
})()`;

const chipNow =`document.querySelector('aside[data-manager] [data-manager-context] span')?.textContent ?? null`;

/** A message of `kind` has ended, or its notices say why it will not. */
const messageEnded = (kind: string) =>
  `document.querySelector('aside[data-manager] [data-message="${kind}"][data-manager-state="done"], aside[data-manager] [data-message="${kind}"][data-manager-state="cut"]') !== null`;

const lastMessage = (kind: string) => `(() => {
  const all = [...document.querySelectorAll('aside[data-manager] [data-message="${kind}"]')];
  const el = all[all.length - 1];
  return el === undefined ? null : {
    text: [...el.children].filter((c, i) => i > 0 && !c.hasAttribute('data-notice')).map((c) => c.textContent).join(' '),
    notices: [...el.querySelectorAll('[data-notice]')].map((n) => n.textContent),
    state: el.getAttribute('data-manager-state'),
    runs: [...el.querySelectorAll('[data-run-link]')].map((a) => a.getAttribute('data-run-link')),
    proposals: [...el.querySelectorAll('[data-proposal]')].map((b) => b.textContent),
  };
})()`;

interface ShownMessage {
  /** The message without its heading line and its notices. */
  text: string;
  notices: string[];
  state: string;
  runs: string[];
  proposals: string[];
}

/**
 * The Manager panel: its head, chip and suggestions on Attention at 1440, the chip changing on Runs
 * and on a run, one suggested question answered with run ids the factory has, the Manager tab at
 * 390, and the design probe over the page with the panel open. It asks the configured model one
 * question, so it spends model budget.
 */
export function managerPhase(ctx: LiveContext): LivePhase {
  const { deps, db, factory } = ctx;
  const failures: string[] = [];
  const report: string[] = [];
  let panelPage: Page | undefined;
  const url = () => `${ctx.base}/f/${encodeURIComponent(factory)}#manager`;
  const waitFor = (page: Page, condition: string) =>
    page.evaluate<boolean>(pageWait(condition, PANEL_WAIT_MS), PANEL_WAIT_MS + 5000);

  return {
    async open() {
      const page = await openPage(deps.env);
      panelPage = page;
      await page.setViewport(1440);
      await page.goto(url());
      if (!(await waitFor(page, `document.querySelector('aside[data-manager="dock"]') !== null`))) {
        throw new Error('the Manager dock did not open on #manager');
      }
      await waitFor(page, `${headCount} !== null`);
      const count = await page.evaluate<number | null>(headCount);
      const shown = await page.evaluate<ShownPanel>(panelOnScreen);
      const mismatches = panelMismatches(shown, count, 'Attention', ATTENTION_QUESTIONS);

      await waitFor(page, messageEnded('briefing'));
      const briefing = await page.evaluate<ShownMessage | null>(lastMessage('briefing'));
      report.push(`briefing: ${JSON.stringify(briefing)}`);
      if (briefing === null || briefing.text.trim() === '') {
        mismatches.push('the briefing is blank');
      } else if (briefing.state !== 'done') {
        mismatches.push(`the briefing did not finish (${briefing.state}): ${briefing.text}`);
      } else if (briefing.notices.length > 0) {
        mismatches.push(`the briefing carries a notice: ${briefing.notices.join(' ')}`);
      }
      ctx.save(FILES.shot, await page.screenshot(1440));

      await page.evaluate(`document.querySelector('nav a[href$="/runs"]').click()`);
      await waitFor(page, `${chipNow} === 'Runs · all'`);
      if ((await page.evaluate<string | null>(chipNow)) !== 'Runs · all') {
        mismatches.push('the chip did not change to "Runs · all" on Runs');
      }
      await waitFor(page, `document.querySelector('${RUN_ROW}') !== null`);
      const run = await page.evaluate<string | null>(
        `document.querySelector('${RUN_ROW}')?.getAttribute('data-run') ?? null`,
      );
      if (run === null) throw new Error('the Runs page listed no run to open');
      await page.evaluate(`document.querySelector('${RUN_ROW}').click()`);
      const runChip = `Run ${run.replace(/-/g, '').slice(0, 8)}`;
      if (!(await waitFor(page, `${chipNow} === '${runChip}'`))) {
        mismatches.push(`the chip did not change to "${runChip}" on the run`);
      }

      await page.evaluate(
        `document.querySelector('aside[data-manager] [data-suggestion]').click()`,
      );
      await waitFor(page, messageEnded('answer'));
      const answer = await page.evaluate<ShownMessage | null>(lastMessage('answer'));
      report.push(`answer: ${JSON.stringify(answer)}`);
      if (answer === null || answer.state !== 'done') {
        mismatches.push(`the suggested question was not answered: ${answer?.text ?? 'no answer'}`);
      } else {
        const known = new Set(
          (
            await db.query('SELECT run_id::text AS run FROM mc.laps WHERE factory = $1', [factory])
          ).map((r) => String(r.run)),
        );
        mismatches.push(...answerMismatches(answer.runs, known));
      }
      ctx.save(FILES.run, await page.screenshot(1440));

      await page.setViewport(390);
      await page.goto(url());
      if (!(await waitFor(page, `document.querySelector('aside[data-manager="tab"]') !== null`))) {
        mismatches.push('the Manager tab did not open on #manager at 390');
      }
      if (!(await page.evaluate<boolean>(overflowConversation))) {
        mismatches.push('the Manager conversation could not be made to overflow at 390, so the fit was not measured');
      }
      const fit = await page.evaluate<{ scrolls: boolean; inputAboveBar: boolean }>(phoneFit);
      if (fit.scrolls) mismatches.push('the Manager tab scrolls the page at 390');
      if (!fit.inputAboveBar) mismatches.push('the Manager input is not above the tab bar at 390');
      ctx.save(FILES.phone, await page.screenshot(390));
      failures.push(...mismatches.map((m) => `manager panel: ${m}`));
      report.push(...mismatches, `mismatches: ${mismatches.length}`);
    },

    async probe(designProbe) {
      designProbe(url(), FILES.probe, 'the Manager panel');
    },

    async close() {
      ctx.save(FILES.check, `${report.join('\n')}\n`);
      await panelPage?.close().catch(() => undefined);
    },

    judge: () => failures,

    summary: () => [
      `manager: ${failures.length === 0 ? 'panel, chip and answer checked' : `${failures.length} failures`}`,
    ],
  };
}
