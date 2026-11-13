/**
 * The Attention page's cards (PRD 4.10, v3 README "Attention"): the rows of `decide`,
 * `owner-queue` and `unstick` as one uniform card, with a manager's note written
 * from the data alone. Pure, no React. The page draws the cards By kind or By queue; the nav badge
 * counts the same rows with `attentionCount`.
 *
 * Every card says in plain sentences what it waits on and what each option does, then ends in option
 * tiles, the recommended one first, and "Something else" last. Failures are not Attention items: they
 * live on Runs (failure-view.ts). Clean up ("safe to clear") is not a group here: no live query names
 * such an item yet.
 */
import type { Source } from '../live/Feed';
import { cardForStep, FACTORY_MAP } from '../map/factory-map';
import { type ActionRequest, type AnswerRequest, type CommentRequest, needsLogin } from './actions';
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
import { localMinute, shortRunId } from './format';
import { askAbout, type ManagerAsk } from './manager';
import { stepPath } from './lap-graph';
import { since } from './laps';
import { consoleUrl, workflowLabel } from './one-lap';
import { type OwnerQueueRow, ownerQueue, waited } from './owner-queue';
import { LAP_OUTCOME_STATE, type State, UNSTICK_STATE } from './states';
import { workItemHref } from './work-item';

export type AttentionKind = 'decide' | 'unstick';

export const KINDS: readonly { kind: AttentionKind; name: string; why: string }[] = [
  { kind: 'decide', name: 'Decide', why: 'a question only you can answer' },
  { kind: 'unstick', name: 'Unstick', why: 'work that stopped moving' },
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
  /** Sends this write in place, when the server holds an operator for the factory. */
  act?: { request: ActionRequest; item: number | null };
  /** Opens the text box: the owner's own words, sent as `request` with `text` filled. */
  somethingElse?: { request: AnswerRequest | CommentRequest; item: number | null };
  /** Opens the Manager's box on this card, for a card no write takes the owner's words for. */
  manager?: ManagerAsk;
  hooks: Hooks;
}

/** A link beside the tiles; the writes are the tiles. */
export interface Action {
  type: 'link';
  variant: 'primary' | 'secondary';
  label: string;
  href: string;
  external: boolean;
  hooks: Hooks;
}

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
  hooks: Hooks;
}

const SOMETHING_ELSE = 'Something else';

/** Recommended tile first, "Something else" last, the rest in the order Archon declared them. */
const recommendedFirst = (tiles: Tile[]): Tile[] => [
  ...tiles.filter((t) => t.recommended),
  ...tiles.filter((t) => !t.recommended && t.label !== SOMETHING_ELSE),
  ...tiles.filter((t) => !t.recommended && t.label === SOMETHING_ELSE),
];

/** Archon's open questions: each option tile answers in place with an operator, and opens the console without one. */
export function decideCards(rows: readonly DecideRow[], factory: string): AttentionCard[] {
  return attentionItems(rows).map((item) => {
    const recommended = item.options.some((o) => o.id === item.recommended)
      ? item.recommended
      : null;
    const link = consoleUrl(item.console, item.run_id);
    const ask = askAbout(item.run_id, item.item_number);
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
        : { act: { request: { ...asked, option: o.id }, item: item.item_number } };
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
        label: SOMETHING_ELSE,
        consequence: resolves(null)
          ? 'Write your own answer'
          : 'Tell the manager what you want; it proposes the action as a button',
        recommended: false,
        href: link,
        // Only a free-text question takes text without a declared option to carry it.
        ...(resolves(null)
          ? { somethingElse: { request: asked, item: item.item_number } }
          : { manager: ask }),
        hooks: { 'data-choice': 'something-else', 'data-something-else': '' },
      });
    }
    const chosen = item.options.find((o) => o.id === recommended);
    const heading = attentionQuestion(item.message);
    const queue = queueOf(item.workflow_name, item.node_id);
    const subject =
      item.item_number === null
        ? `Run ${shortRunId(item.run_id)}`
        : item.item_title === null
          ? `#${item.item_number}`
          : `#${item.item_number} “${item.item_title}”`;
    return {
      key: `decide:${item.run_id}`,
      kind: ATTENTION_SOURCES.decide.kind,
      queue,
      dot: 'needs-you',
      title: item.item_number === null ? heading : `#${item.item_number}: ${heading}`,
      age: { since: item.waiting_since },
      meta: [
        { mono: item.workflow_name },
        { pill: attentionOrigin(item), state: 'needs-you' },
        { mono: item.node_id },
      ],
      note: {
        lead: `${subject} waits at ${item.node_id} for your answer since ${localMinute(item.waiting_since)}. ${
          chosen === undefined
            ? 'There is no recommendation.'
            : `Recommends ${chosen.label ?? chosen.id}.`
        }`,
        rest:
          chosen === undefined
            ? ''
            : (item.recommendation_why ?? recommendationReason(item.message)),
      },
      tiles: recommendedFirst(tiles),
      ...(item.confidence === null ? {} : { confidence: `${item.confidence} confidence` }),
      ask,
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
        'data-attention-kind': ATTENTION_SOURCES.decide.kind,
        'data-attention-queue': queue,
        'data-waiting-since': item.waiting_since.toISOString(),
        'data-console': link,
      },
    };
  });
}

const timeOf = (at: Date | null) => (at === null ? Number.POSITIVE_INFINITY : at.getTime());

const momentOf = (at: Date | null, none: string) => (at === null ? none : localMinute(at));

/** The old loop's owner items, answered on GitHub; the loop applies a question's default when nobody answers. No write takes an answer on GitHub, so Something else hands the owner's words to the Manager. */
export function ownerCards(rows: readonly OwnerQueueRow[]): AttentionCard[] {
  return ownerQueue(rows).map((item) => {
    const question = item.kind === 'question';
    const ask = askAbout(null, item.issue_number);
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
    const options: Tile[] = question
      ? item.options.map((o) => ({
          id: o.key,
          label: `${o.key}. ${o.text}`,
          recommended: o.key === item.default_option,
          href: item.url,
          hooks: {
            'data-option': o.key,
            'data-option-text': o.text,
            'data-default': o.key === item.default_option ? '' : undefined,
          },
        }))
      : [
          {
            id: 'reply',
            label: 'Reply on GitHub',
            consequence: 'Opens the issue, where you answer in a comment',
            recommended: true,
            href: item.url,
            hooks: { 'data-choice': 'reply' },
          },
        ];
    return {
      key: `owner:${item.id}`,
      kind: ATTENTION_SOURCES.owner.kind,
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
            lead: `#${item.issue_number} asks question ${item.question_number} since ${momentOf(item.waiting_since, 'a time not recorded')}. ${
              item.default_option === null
                ? 'There is no default.'
                : `Default ${item.default_option} applies ${momentOf(item.default_at, 'at a time not recorded')}.`
            }`,
            rest: item.recommendation ?? '',
          }
        : {
            lead: `#${item.issue_number} “${item.title}” has been labelled needs-owner since ${momentOf(item.waiting_since, 'a time not recorded')}.`,
            rest: 'It waits for your reply on the issue.',
          },
      tiles: recommendedFirst([
        ...options,
        {
          id: 'something-else',
          label: SOMETHING_ELSE,
          consequence: 'Tell the manager what you want; it proposes the action as a button',
          recommended: false,
          href: item.url,
          manager: ask,
          hooks: { 'data-choice': 'something-else', 'data-something-else': '' },
        },
      ]),
      actions,
      ask,
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
        'data-attention-kind': ATTENTION_SOURCES.owner.kind,
        'data-attention-queue': 'build',
      },
    };
  });
}

/** What an item is called in a sentence: `#455 “title”`, or `#455` when its title is not mirrored. */
const named = (number: number | string, title: string | null | undefined) =>
  title ? `#${number} “${title}”` : `#${number}`;

/** The blockers of a row, `#455 “title”`, in the order of its `waits_on`. */
function blockers(row: UnstickRow): string[] {
  return row.waits_on
    .split(', ')
    .map((ref, i) => named(ref.replace('#', ''), row.blocker_titles?.[i]));
}

/** "#B “t” closed 2026-10-24 09:08." or, for several, "#B “t”, #C “u” all closed by 2026-10-24 09:08." */
function closedSentence(row: UnstickRow): string {
  const list = blockers(row);
  const when = row.since === null ? '' : ` ${localMinute(row.since)}`;
  return list.length === 1
    ? `${list[0]} closed${when}.`
    : `${list.join(', ')} all closed${when === '' ? '' : ` by${when}`}.`;
}

/** A card's key, which the live phase reads back to find the card of a row. */
export const unstickKey = (row: Pick<UnstickRow, 'kind' | 'number' | 'run_id'>): string =>
  `unstick:${row.kind}:${row.number ?? ''}:${row.run_id ?? ''}`;

const RETRIAGE_DOES = 'Adds archon-triage and starts an intake run; triage decides its next stage';
const CLOSE_DOES =
  'Closes the issue as not planned, with a comment that you closed it from Mission Control';
const COMMENT_DOES = 'Posts your text on the issue as your comment, then re-triages it';

/**
 * Work that stopped moving: re-triage, close or comment on the item, or resume a run waiting for a
 * slot. The tile `row.action` names is the recommended one. `loginMissing` is an operator with no
 * `login`: the server refuses re-triage and comment for it, so only Close is offered.
 */
export function unstickCards(
  rows: readonly UnstickRow[],
  factory: string,
  loginMissing: boolean,
): AttentionCard[] {
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
      const ask = askAbout(row.run_id, row.number);
      const itemHref = row.number === null ? null : workItemHref(factory, row.number);
      const open: Action[] =
        row.number === null || itemHref === null
          ? []
          : [
              {
                type: 'link',
                variant: 'secondary',
                label: `Open #${row.number}`,
                href: itemHref,
                external: false,
                hooks: {},
              },
            ];
      const act = (
        id: 'retriage' | 'close' | 'resume',
        label: string,
        consequence: string,
        request: ActionRequest,
        href: string | null,
      ): Tile => ({
        id,
        label,
        consequence,
        recommended: id === row.action,
        href,
        act: { request, item: row.number },
        hooks: {
          'data-choice': id,
          'data-act': id,
          'data-act-item': row.number === null ? undefined : String(row.number),
        },
      });
      const writable = row.number !== null && row.open;
      const offered = (action: ActionRequest['action']) => !(loginMissing && needsLogin(action));
      const commentable = writable && offered('comment');
      const withheld = !writable
        ? ` ${n} is not an open issue, so re-triage, close and comment are not offered; open it to see where it stands.`
        : loginMissing
          ? ' Re-triage and comments need the operator’s `login`, which this factory’s operator entry lacks; Close is offered.'
          : '';
      const closedNote = row.number === null ? '' : withheld;
      const somethingElse = (): Tile =>
        !commentable || row.number === null
          ? {
              id: 'something-else',
              label: SOMETHING_ELSE,
              consequence:
                writable && loginMissing
                  ? 'Tell the manager what you want; for re-triage or a comment it can only link the issue, since those need the operator’s `login`'
                  : 'Tell the manager what you want; it proposes the action as a button',
              recommended: false,
              href: itemHref,
              manager: ask,
              hooks: { 'data-choice': 'something-else', 'data-something-else': '' },
            }
          : {
              id: 'something-else',
              label: SOMETHING_ELSE,
              consequence: COMMENT_DOES,
              recommended: false,
              href: itemHref,
              somethingElse: {
                request: { factory, action: 'comment', number: row.number, text: '' },
                item: row.number,
              },
              hooks: { 'data-choice': 'something-else', 'data-something-else': '' },
            };
      const itemWrites = (): Tile[] =>
        !writable || row.number === null
          ? []
          : [
              ...(offered('retriage')
                ? [
                    act(
                      'retriage',
                      `Re-triage #${row.number}`,
                      RETRIAGE_DOES,
                      { factory, action: 'retriage', number: row.number },
                      itemHref,
                    ),
                  ]
                : []),
              act(
                'close',
                `Close #${row.number}`,
                CLOSE_DOES,
                { factory, action: 'close', number: row.number },
                itemHref,
              ),
            ];
      const base = {
        key,
        kind: ATTENTION_SOURCES.unstick.kind,
        queue,
        dot: 'needs-you',
        age: { since: row.since },
        ask,
        actions: open,
        hooks: {
          'data-attention-item': key,
          'data-attention-kind': ATTENTION_SOURCES.unstick.kind,
          'data-attention-queue': queue,
          'data-unstick-kind': row.kind,
          'data-number': row.number === null ? undefined : String(row.number),
          'data-waits-on': row.waits_on,
        },
      } as const;
      const workflow: MetaPart[] = row.workflow_name === null ? [] : [{ mono: row.workflow_name }];
      const waits: MetaPart = { text: `waits on ${row.waits_on}` };
      const label = row.workflow_name === null ? '' : workflowLabel(row.workflow_name);
      switch (row.kind) {
        case 'blocked':
        case 'parked': {
          const closed = row.waits_on.includes(',') ? 'all have closed' : 'it has closed';
          return {
            ...base,
            title: `${n} is ${row.kind} on ${row.waits_on}, and ${closed}`,
            meta: [{ pill: row.kind, state: UNSTICK_STATE[row.kind] }, waits],
            note: {
              lead: closedSentence(row),
              rest:
                (row.kind === 'blocked'
                  ? `${n}'s issue says it depends on ${row.waits_on}, so triage put it in blocked. A named build round refuses blocked items.`
                  : `${n} was parked on ${row.waits_on.includes(',') ? 'them' : 'it'}${row.reason === null ? '' : `: “${row.reason}”`}. Nothing re-triages a parked item on its own.`) +
                closedNote,
            },
            tiles: [...itemWrites(), somethingElse()],
          };
        }
        case 'capacity': {
          const since = row.since === null ? '' : ` since ${localMinute(row.since)}`;
          const resume: Tile[] =
            row.run_id === null
              ? []
              : [
                  act(
                    'resume',
                    `Resume run ${run}`,
                    'Asks Archon to continue the run now',
                    { factory, action: 'resume', run_id: row.run_id, from_step: null },
                    consoleUrl(row.console, row.run_id),
                  ),
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
              lead: `Run ${run} of ${label} was answered and has waited for a free slot${since}.`,
              rest: `Runs in this state do not always continue on their own.${closedNote}`,
            },
            tiles: [...resume, ...itemWrites(), somethingElse()],
          };
        }
        case 'claim':
          return {
            ...base,
            title: `${n} is claimed by run ${run}, which has finished`,
            meta: [...workflow, { pill: 'claimed', state: UNSTICK_STATE.claim }, waits],
            note: {
              lead: `Run ${run} of ${label} finished${row.since === null ? '' : ` at ${localMinute(row.since)}`} and still claims ${n}.`,
              rest: `Any intake run releases the claim${commentable ? `; re-triaging ${n} starts one and keeps its build progress` : ''}.${closedNote}`,
            },
            tiles: [...itemWrites(), somethingElse()],
          };
        default:
          return row.kind satisfies never;
      }
    });
}

/**
 * The live queries the page and the nav badge both read: one table, so the cards, the count
 * and the live phase cannot disagree about which sources make "what needs you".
 */
export const ATTENTION_SOURCES = {
  decide: { query: 'decide', kind: 'decide', what: 'what is waiting on you' },
  owner: { query: 'owner-queue', kind: 'decide', what: 'the owner queue' },
  unstick: { query: 'unstick', kind: 'unstick', what: 'what stopped moving' },
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

/**
 * The head's line under the title. The sweep clause is left out when the factory has no finished
 * manager run; the recommendation clause only when cards are drawn, since "each" needs items.
 */
export function sweepLine(
  factory: string,
  sweptAt: Date | null,
  now: number,
  cardsDrawn: number,
): string {
  const seconds = since(sweptAt, now);
  const items = cardsDrawn > 0;
  if (seconds === null) return items ? `${factory}. The manager ${RECOMMENDATION}` : `${factory}.`;
  return items
    ? `${factory}. The manager swept ${waited(seconds)} ago and ${RECOMMENDATION}`
    : `${factory}. The manager swept ${waited(seconds)} ago.`;
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
