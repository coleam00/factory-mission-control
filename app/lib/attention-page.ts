/**
 * The Attention page's cards (PRD 4.10, v3 README "Attention"): the rows of `decide`,
 * `owner-queue`, `unstick` and `failure-groups` as one uniform card, with a manager's note written
 * from the data alone. Pure, no React. The page draws the cards By kind or By queue; the nav badge
 * counts the same rows with `attentionCount`.
 *
 * Clean up ("safe to clear") is not a group here: no live query names such an item yet.
 */
import type { Source } from '../live/Feed';
import { cardForStep, FACTORY_MAP } from '../map/factory-map';
import type { ActionRequest, AnswerRequest } from './actions';
import {
  type DecideRow,
  attentionItems,
  attentionOrigin,
  attentionQuestion,
  recommendationReason,
  resolveAnswer,
  UNSTICK_KINDS,
  type UnstickRow,
} from './attention';
import type { FailureGroupRow, StopClass } from './failures';
import { shortRunId } from './format';
import { askAbout, type ManagerAsk } from './manager';
import { stepPath } from './lap-graph';
import { since } from './laps';
import { consoleUrl, INTAKE_WORKFLOW, lapHref, workflowLabel } from './one-lap';
import { type OwnerQueueRow, ownerQueue, waited } from './owner-queue';
import { LAP_OUTCOME_STATE, STOP_CLASS_STATE, type State, UNSTICK_STATE } from './states';
import { workItemHref } from './work-item';

export type AttentionKind = 'decide' | 'unstick' | 'fix';

export const KINDS: readonly { kind: AttentionKind; name: string; why: string }[] = [
  { kind: 'decide', name: 'Decide', why: 'a question only you can answer' },
  { kind: 'unstick', name: 'Unstick', why: 'work that stopped moving' },
  { kind: 'fix', name: 'Fix', why: 'failures, grouped by cause' },
];

export type AttentionQueue = 'intake' | 'build' | 'merge' | 'app-check' | 'discoveries' | 'other';

export const QUEUES: readonly { queue: AttentionQueue; name: string }[] = [
  { queue: 'intake', name: 'Intake' },
  { queue: 'build', name: 'Build' },
  { queue: 'merge', name: 'Merge' },
  { queue: 'app-check', name: 'App check' },
  { queue: 'discoveries', name: 'Discoveries' },
  { queue: 'other', name: 'Other' },
];

/** The queue a root card of the factory map belongs to; a card not listed (Manager, Staging, ...) is Other. */
export const QUEUE_OF_CARD: Readonly<Record<string, AttentionQueue>> = {
  split: 'intake',
  intake: 'intake',
  build: 'build',
  review: 'build',
  merge: 'merge',
  app: 'app-check',
  disc: 'discoveries',
};

/**
 * The queue the factory map gives a step: the card covering it, else (no step, or one no card
 * covers) the first card covering the workflow at all. A workflow no card covers is Other.
 */
export function queueOf(workflow: string | null, step: string | null = null): AttentionQueue {
  if (workflow === null) return 'other';
  const card =
    (step === null ? undefined : cardForStep(FACTORY_MAP, workflow, stepPath(step))) ??
    FACTORY_MAP.cards.find((c) => c.covers.some((cover) => cover.workflow === workflow));
  return QUEUE_OF_CARD[card?.id ?? ''] ?? 'other';
}

export type MetaPart = { mono: string } | { pill: string; state: State } | { text: string };

type Hooks = Record<`data-${string}`, string | undefined>;

export interface Tile {
  id: string;
  label: string;
  consequence?: string;
  recommended: boolean;
  /** Where the answer is given; null when the item has no address. */
  href: string | null;
  /** Answers in place with this option, when the server holds an operator for the factory. */
  answer?: { request: AnswerRequest; item: number | null };
  /** Opens the text box: the answer is the owner's own words, sent as `request` with `text` filled. */
  somethingElse?: { request: AnswerRequest; item: number | null };
  hooks: Hooks;
}

export type Action =
  | {
      type: 'link';
      variant: 'primary' | 'secondary';
      label: string;
      href: string;
      external: boolean;
      hooks: Hooks;
    }
  | {
      /** Acts in place when the server holds an operator for the factory, else it is `fallback`. */
      type: 'act';
      variant: 'primary' | 'secondary';
      label: string;
      request: ActionRequest;
      fallback: { href: string; external: boolean };
      hooks: Hooks;
    }
  | { type: 'copy'; variant: 'primary' | 'secondary'; label: string; command: string };

export interface AttentionCard {
  key: string;
  kind: AttentionKind;
  queue: AttentionQueue;
  dot: State;
  title: string;
  age: { since: Date | null } | { text: string };
  meta: MetaPart[];
  note: { lead: string; rest: string; code?: string };
  tiles: Tile[];
  confidence?: string;
  actions: Action[];
  /** What "Ask manager" hands the panel: the run and work item this card is about. */
  ask: ManagerAsk;
  /** Failures per day, oldest first (Fix). */
  daily?: number[];
  hooks: Hooks;
}

/** `gh` and `archon` as the queues' own procedure runs them (archon-cli skill, operate/queues.md). */
export const retriageCommand = (repository: string, number: number): string =>
  `gh issue edit ${number} --repo ${repository} --add-label archon-triage && archon workflow run ${INTAKE_WORKFLOW} --input repo_host=github.com --input repo_path=${repository} --input number=${number} --input action=added --input label=archon-triage --input label_actor="$(gh api user --jq .login)" --detach`;

export const releaseCommand = (repository: string, workflow: string): string =>
  `archon workflow run ${workflow} --input repo_host=github.com --input repo_path=${repository} --detach`;

/** Archon's open questions: each option tile answers in place with an operator, and opens the console without one. */
export function decideCards(rows: readonly DecideRow[], factory: string): AttentionCard[] {
  return attentionItems(rows).map((item) => {
    const recommended = item.options.some((o) => o.id === item.recommended)
      ? item.recommended
      : null;
    const link = consoleUrl(item.console, item.run_id);
    const question = { form: item.form, options: item.options };
    const resolves = (option: string | null) =>
      !('error' in resolveAnswer(question, { option, text: null }));
    const asked: AnswerRequest = {
      factory,
      action: 'answer',
      run_id: item.run_id,
      occurrence: item.occurrence_id,
      option: null,
      text: null,
    };
    const tiles: Tile[] = item.options.map((o) => {
      const label = o.label ?? o.id;
      // "Something else" takes the owner's text; any other option is the answer itself.
      const place = !resolves(o.id)
        ? { somethingElse: { request: asked, item: item.item_number } }
        : { answer: { request: { ...asked, option: o.id }, item: item.item_number } };
      return {
        id: o.id,
        label,
        ...(o.description === null ? {} : { consequence: o.description }),
        recommended: o.id === recommended,
        href: link,
        ...place,
        hooks: { 'data-choice': o.id },
      };
    });
    if (item.options.every((o) => resolves(o.id))) {
      tiles.push({
        id: 'something-else',
        label: 'Something else',
        consequence: 'Write your own answer',
        recommended: false,
        href: link,
        // Only a free-text question takes text without a declared option to carry it.
        ...(resolves(null) ? { somethingElse: { request: asked, item: item.item_number } } : {}),
        hooks: { 'data-choice': 'something-else', 'data-something-else': '' },
      });
    }
    const chosen = item.options.find((o) => o.id === recommended);
    const heading = attentionQuestion(item.message);
    const queue = queueOf(item.workflow_name, item.node_id);
    return {
      key: `decide:${item.run_id}`,
      kind: 'decide',
      queue,
      dot: 'needs-you',
      title: item.item_number === null ? heading : `#${item.item_number}: ${heading}`,
      age: { since: item.waiting_since },
      meta: [
        { mono: item.workflow_name },
        { pill: attentionOrigin(item), state: 'needs-you' },
        { mono: item.node_id },
      ],
      note:
        chosen === undefined
          ? {
              lead: 'No recommendation.',
              rest: `The run waits at ${item.node_id} until you answer.`,
            }
          : {
              lead: `Recommends ${chosen.label ?? chosen.id}.`,
              rest: recommendationReason(item.message),
            },
      tiles,
      ...(item.confidence === null ? {} : { confidence: `${item.confidence} confidence` }),
      ask: askAbout(item.run_id, item.item_number),
      actions: [
        item.item_number === null
          ? {
              type: 'link',
              variant: 'secondary',
              label: 'Open in console',
              href: link,
              external: true,
              hooks: {},
            }
          : {
              type: 'link',
              variant: 'secondary',
              label: `Open #${item.item_number}`,
              href: workItemHref(factory, item.item_number),
              external: false,
              hooks: {},
            },
      ],
      hooks: {
        'data-attention-item': item.run_id,
        'data-attention-kind': 'decide',
        'data-attention-queue': queue,
        'data-waiting-since': item.waiting_since.toISOString(),
        'data-console': link,
      },
    };
  });
}

const timeOf = (at: Date | null) => (at === null ? Number.POSITIVE_INFINITY : at.getTime());

const utcMinute = (at: Date) => `${at.toISOString().slice(0, 16).replace('T', ' ')} UTC`;

/** The old loop's owner items, answered on GitHub; the loop applies a question's default when nobody answers. */
export function ownerCards(rows: readonly OwnerQueueRow[]): AttentionCard[] {
  return ownerQueue(rows).map((item) => {
    const question = item.kind === 'question';
    const actions: Action[] =
      item.url === null
        ? []
        : [
            {
              type: 'link',
              variant: 'secondary',
              label: question ? `Open #${item.issue_number} on GitHub` : 'Answer on GitHub',
              href: item.url,
              external: true,
              hooks: { 'data-thread': '' },
            },
          ];
    return {
      key: `owner:${item.id}`,
      kind: 'decide',
      queue: 'build',
      dot: 'needs-you',
      title: item.title,
      age: { since: item.waiting_since },
      meta: question
        ? [
            { pill: 'owner question', state: 'needs-you' },
            { text: `#${item.issue_number} · Q${item.question_number}` },
          ]
        : [
            { pill: 'needs-owner', state: LAP_OUTCOME_STATE['needs-owner'] },
            { text: `#${item.issue_number}` },
          ],
      note: question
        ? {
            lead:
              item.default_option === null
                ? 'No default.'
                : `Default ${item.default_option} applies ${
                    item.default_at === null ? 'at a time not recorded' : utcMinute(item.default_at)
                  }.`,
            rest: item.recommendation ?? '',
          }
        : { lead: 'Labelled needs-owner.', rest: 'It waits for your reply on the issue.' },
      tiles: item.options.map((o) => ({
        id: o.key,
        label: `${o.key}. ${o.text}`,
        recommended: o.key === item.default_option,
        href: item.url,
        hooks: {
          'data-option': o.key,
          'data-option-text': o.text,
          'data-default': o.key === item.default_option ? '' : undefined,
        },
      })),
      actions,
      ask: askAbout(null, item.issue_number),
      hooks: {
        'data-owner-item': item.id,
        'data-kind': item.kind,
        'data-issue': String(item.issue_number),
        'data-question-number':
          item.question_number === null ? undefined : String(item.question_number),
        'data-url': item.url ?? undefined,
        'data-waiting-since': item.waiting_since?.toISOString(),
        'data-approximate': item.approximate ? 'true' : undefined,
        'data-default-option': item.default_option ?? undefined,
        'data-default-at': item.default_at?.toISOString(),
        'data-attention-kind': 'decide',
        'data-attention-queue': 'build',
      },
    };
  });
}

const closed = (waitsOn: string) => (waitsOn.includes(',') ? 'all have closed' : 'it has closed');

/** A card's key, which the live phase reads back to find the card of a row. */
export const unstickKey = (row: Pick<UnstickRow, 'kind' | 'number' | 'run_id'>): string =>
  `unstick:${row.kind}:${row.number ?? ''}:${row.run_id ?? ''}`;

/** Work that stopped moving. Re-triage and releasing a claim are copied commands; Resume opens the run in the console. */
export function unstickCards(rows: readonly UnstickRow[], factory: string): AttentionCard[] {
  return [...rows]
    .sort(
      (a, b) =>
        timeOf(a.since) - timeOf(b.since) ||
        UNSTICK_KINDS.indexOf(a.kind) - UNSTICK_KINDS.indexOf(b.kind) ||
        (a.number ?? 0) - (b.number ?? 0),
    )
    .map((row): AttentionCard => {
      const key = unstickKey(row);
      const queue = row.workflow_name === null ? 'intake' : queueOf(row.workflow_name);
      const n = row.number === null ? null : `#${row.number}`;
      const run = row.run_id === null ? null : shortRunId(row.run_id);
      const open: Action[] =
        row.number === null
          ? []
          : [
              {
                type: 'link',
                variant: 'secondary',
                label: `Open #${row.number}`,
                href: workItemHref(factory, row.number),
                external: false,
                hooks: {},
              },
            ];
      const base = {
        key,
        kind: 'unstick',
        queue,
        dot: 'needs-you',
        age: { since: row.since },
        tiles: [] as Tile[],
        ask: askAbout(row.run_id, row.number),
        hooks: {
          'data-attention-item': key,
          'data-attention-kind': 'unstick',
          'data-attention-queue': queue,
          'data-unstick-kind': row.kind,
          'data-number': row.number === null ? undefined : String(row.number),
        },
      } as const;
      const workflow: MetaPart[] = row.workflow_name === null ? [] : [{ mono: row.workflow_name }];
      const waits: MetaPart = { text: `waits on ${row.waits_on}` };
      switch (row.action) {
        case 'retriage': {
          const copy: Action[] =
            row.number === null
              ? []
              : [
                  {
                    type: 'copy',
                    variant: 'primary',
                    label: 'Copy the re-triage command',
                    command: retriageCommand(row.repository, row.number),
                  },
                ];
          return {
            ...base,
            title: `${n} is ${row.kind} on ${row.waits_on}, and ${closed(row.waits_on)}`,
            meta: [{ pill: row.kind, state: UNSTICK_STATE[row.kind] }, waits],
            note:
              row.kind === 'blocked'
                ? {
                    lead: 'The blocker is gone.',
                    rest: 'A named build round refuses blocked items, so it waits for the next revisit unless you re-triage it.',
                  }
                : {
                    lead: 'What it was parked on has closed.',
                    rest: 'A parked item waits until it is re-triaged.',
                  },
            actions: [...copy, ...open],
          };
        }
        case 'resume': {
          const resume: Action[] =
            row.run_id === null
              ? []
              : [
                  {
                    type: 'act',
                    variant: 'primary',
                    label: `Resume ${run}`,
                    request: { factory, action: 'resume', run_id: row.run_id, from_step: null },
                    fallback: { href: consoleUrl(row.console, row.run_id), external: true },
                    hooks: { 'data-act': 'resume', 'data-act-run': row.run_id },
                  },
                ];
          return {
            ...base,
            title:
              n === null
                ? `Run ${run} was answered, but it is waiting for a slot`
                : `${n} was answered, but its run is waiting for a slot`,
            meta: [
              ...workflow,
              { pill: 'answered · waiting for capacity', state: UNSTICK_STATE.capacity },
              waits,
            ],
            note: {
              lead: 'Answered, waiting for a free slot.',
              rest: 'Runs in this state do not always continue on their own; resuming once a slot frees moves it.',
            },
            actions: [...resume, ...open],
          };
        }
        case 'release_claim': {
          const release: Action[] =
            row.workflow_name === null
              ? []
              : [
                  {
                    type: 'copy',
                    variant: 'primary',
                    label: `Copy the command for a new ${workflowLabel(row.workflow_name)} run`,
                    command: releaseCommand(row.repository, row.workflow_name),
                  },
                ];
          return {
            ...base,
            title: `${n} is claimed by run ${run}, which has finished`,
            meta: [...workflow, { pill: 'claimed', state: UNSTICK_STATE.claim }, waits],
            note: {
              lead: 'The run holding the claim has finished.',
              rest: 'A new run of its queue that names no item releases it.',
            },
            actions: [...release, ...open],
          };
        }
        default:
          return row.action satisfies never;
      }
    });
}

const CLASS_NOTE: Readonly<Record<StopClass | 'mixed', string>> = {
  transient: 'It is transient: a retry usually passes.',
  environment: 'It is the environment, not the code.',
  config: 'It is configuration: a binding, a schedule or a credential.',
  code: 'It is a code failure.',
  input: 'It is the input: the run was given something it could not use.',
  mixed: 'Its runs differ in class.',
};

const DAY_MS = 86_400_000;
const utcDay = (at: Date) => Math.floor(at.getTime() / DAY_MS);
const lastTime = (g: FailureGroupRow) => g.last_at?.getTime() ?? 0;

/** One card per failure signature, with the days it spans (UTC calendar days, inclusive). */
export function fixCards(rows: readonly FailureGroupRow[], factory: string): AttentionCard[] {
  return [...rows]
    .sort(
      (a, b) =>
        b.failures - a.failures ||
        lastTime(b) - lastTime(a) ||
        a.signature.localeCompare(b.signature),
    )
    .map((g): AttentionCard => {
      const days =
        g.first_at === null || g.last_at === null ? 1 : utcDay(g.last_at) - utcDay(g.first_at) + 1;
      const queue = queueOf(g.workflow_name, g.step_id);
      const label = workflowLabel(g.workflow_name);
      const run = { href: lapHref(factory, g.latest_run_id), external: false };
      return {
        key: `fix:${g.signature}`,
        kind: 'fix',
        queue,
        dot: 'failed',
        title: g.step_id === null ? `${label} failed` : `${label} failed at ${g.step_id}`,
        age:
          g.failures > 1
            ? { text: `${g.failures} runs · ${days} ${days === 1 ? 'day' : 'days'}` }
            : { since: g.last_at },
        meta: [
          { mono: g.workflow_name },
          ...(g.step_id === null ? [] : [{ text: `step ${g.step_id}` }]),
          { pill: g.class ?? 'unclassified', state: STOP_CLASS_STATE[g.class ?? 'unclassified'] },
        ],
        note: {
          lead:
            g.failures === 1
              ? '1 failed run has this cause.'
              : `${g.failures} failed runs share this cause.`,
          rest: g.class === null ? 'It is not classified.' : CLASS_NOTE[g.class],
          ...(g.line === null ? {} : { code: g.line }),
        },
        tiles: [],
        ask: askAbout(g.latest_run_id, null),
        actions: [
          {
            type: 'link',
            variant: 'secondary',
            label: `Open run ${shortRunId(g.latest_run_id)}`,
            ...run,
            hooks: {},
          },
        ],
        daily: g.daily,
        hooks: {
          'data-attention-item': g.signature,
          'data-attention-kind': 'fix',
          'data-attention-queue': queue,
          'data-latest-run': g.latest_run_id,
          'data-failures': String(g.failures),
        },
      };
    });
}

/**
 * The four live queries the page and the nav badge both read: one table, so the cards, the count
 * and the live phase cannot disagree about which sources make "what needs you".
 */
export const ATTENTION_SOURCES = {
  decide: { query: 'decide', what: 'what is waiting on you' },
  owner: { query: 'owner-queue', what: 'the owner queue' },
  unstick: { query: 'unstick', what: 'what stopped moving' },
  failures: { query: 'failure-groups', what: 'failures' },
} as const;

/** The nav badge's panel of one of those queries, named apart from the page's own panel of it. */
export const badgePanelName = (query: string): string => `attention-count:${query}`;

/** The query for the head's sweep clause; it is not an item source, so the count never reads it. */
export const SWEEP_QUERY = 'manager-sweep';

/** The one row of manager-sweep.sql: when the manager's last finished run completed; null when it has none. */
export interface SweepRow {
  swept_at: Date | null;
}

const RECOMMENDATION = 'put its recommendation first on each.';

/** The head's line under the title. The sweep clause is left out when the factory has no finished manager run. */
export function sweepLine(factory: string, sweptAt: Date | null, now: number): string {
  const seconds = since(sweptAt, now);
  return seconds === null
    ? `${factory}. The manager ${RECOMMENDATION}`
    : `${factory}. The manager swept ${waited(seconds)} ago and ${RECOMMENDATION}`;
}

/**
 * The number of things needing the owner across the sources: unavailable when any query errored
 * (rows kept through an outage are from before it), loading while any has not answered.
 */
export function attentionCount(
  sources: readonly Source<object>[],
): number | 'loading' | 'unavailable' {
  if (sources.some((s) => s.state === 'error')) return 'unavailable';
  if (sources.some((s) => s.rows === undefined)) return 'loading';
  return sources.reduce((n, s) => n + (s.rows?.length ?? 0), 0);
}

/** The groups in README order; an empty group is not drawn. */
export const byKind = (cards: readonly AttentionCard[]) =>
  KINDS.map((k) => ({ ...k, cards: cards.filter((c) => c.kind === k.kind) })).filter(
    (g) => g.cards.length > 0,
  );

/** The same cards under their queues; an empty queue is not drawn. */
export const byQueue = (cards: readonly AttentionCard[]) =>
  QUEUES.map((q) => ({ ...q, cards: cards.filter((c) => c.queue === q.queue) })).filter(
    (g) => g.cards.length > 0,
  );
