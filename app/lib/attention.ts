/**
 * The Attention page's attention items (PRD 4.9): `db/queries/attention-items.sql`'s rows as the
 * runs waiting on a person, longest-waiting first. Pure, no React; the browser's clock gives the
 * wait. The title and the question are read from the layout the pack's queues render. Archon stores
 * the recommendation and each option's effect on the wait (#5367); `db/queries/decide.sql` has them
 * projected with the confidence, item number and occurrence id (migrations 0031 and
 * 20261110T1600Z), reading the wait's fields first. The message parsers here are the fallback for
 * waits recorded before that.
 */

/** One row of attention-items.sql. Timestamps are the database's; the browser computes elapsed times. */
export interface AttentionRow {
  run_id: string;
  workflow_name: string;
  node_id: string;
  waiting_since: Date;
  form: string;
  /** The choices as JSON text: `[{"id":"ship","label":"Ship"}]`. */
  options: string;
  /** Archon's labels as JSON text: `{"build":"scope"}`. */
  labels: string;
  /** The recommended option's id as projected (migration 20261110T1600Z), null when none. */
  recommended: string | null;
  message: string;
  /** The factory's Archon console, for the run link. */
  console: string;
}

export interface AttentionOption {
  id: string;
  label: string | null;
  /** The option's `does`, else the choice line's text after its label, when the message has one. */
  description: string | null;
}

/** One row of decide.sql: an attention-items.sql row with what #516's cards and #521's Answer need. */
export interface DecideRow extends AttentionRow {
  /** Archon's occurrence of the wait: its pause id, else `legacy:<step>`. What an answer names. */
  occurrence_id: string;
  confidence: string | null;
  /** Archon's `recommendation.why`; null for a wait recorded before Archon stored it. */
  recommendation_why: string | null;
  item_number: number | null;
  /** The title of the issue or pull request `item_number` names; null when it is not mirrored. */
  item_title: string | null;
}

export type DecideItem = AttentionItem &
  Pick<
    DecideRow,
    | 'occurrence_id'
    | 'recommended'
    | 'confidence'
    | 'recommendation_why'
    | 'item_number'
    | 'item_title'
  >;

export const UNSTICK_KINDS = ['blocked', 'parked', 'capacity', 'claim'] as const;
export const UNSTICK_ACTIONS = ['retriage', 'resume'] as const;

/** One row of unstick.sql: work that stopped moving, what it waits on, since when, and the one action that moves it. */
export interface UnstickRow {
  kind: (typeof UNSTICK_KINDS)[number];
  number: number | null;
  run_id: string | null;
  workflow_name: string | null;
  waits_on: string;
  since: Date | null;
  action: (typeof UNSTICK_ACTIONS)[number];
  /** The title of the item `number` names; null for an item-less row or one not mirrored. */
  title: string | null;
  /** The titles of what it waits on, in the order of `waits_on`; an empty string where one is not mirrored. */
  blocker_titles: string[] | null;
  /** Why the build queue parked it, from the work item's state; null for any other kind. */
  reason: string | null;
  /** The factory's Archon console, for a run link. */
  console: string;
  /** Whether the mirror holds the item `number` names open; the item writes are offered only then. */
  open: boolean;
}

export interface AttentionItem extends Omit<AttentionRow, 'options' | 'labels'> {
  options: AttentionOption[];
  labels: Record<string, string>;
}

/** The option that takes the owner's own words: labelled "Something else" (its id when unlabelled). Client tiles and the action endpoint both decide with this. */
export const isSomethingElse = (option: { id: string; label: string | null }): boolean =>
  (option.label ?? option.id).toLowerCase() === 'something else';

/** A free-text question takes text with no option to carry it. */
export const takesFreeText = (form: string | null): boolean => form === 'message';

/** The longest answer text the action endpoint takes; the Attention textarea and the Manager's proposals stop at the same length. */
export const ANSWER_TEXT_MAX = 2000;

/** The one rule for answer text: 1 to ANSWER_TEXT_MAX characters. */
export const isAnswerText = (text: unknown): text is string =>
  typeof text === 'string' && text.length >= 1 && text.length <= ANSWER_TEXT_MAX;

/**
 * Whether the owner's option or text answers the question, and which option the CLI is told to
 * choose: free text on a question without free-text form rides on its "Something else" option.
 * The action endpoint and the Manager's proposals both decide with this; `error` is the endpoint's 409.
 */
export function resolveAnswer(
  question: { form: string | null; options: AttentionOption[] },
  answer: { option: string | null; text: string | null },
): { option: string | null } | { error: string } {
  if (answer.option !== null) {
    const offered = question.options.find((o) => o.id === answer.option);
    if (offered === undefined) return { error: 'that option is not offered' };
    if (isSomethingElse(offered)) return { error: 'that option needs your text' };
    return { option: offered.id };
  }
  if (takesFreeText(question.form)) return { option: null };
  const other = question.options.find(isSomethingElse);
  if (other === undefined) return { error: 'this question takes no free text' };
  return { option: other.id };
}

/** The choices, in order; an unreadable value is no choices rather than a broken screen. */
export function parseChoices(text: string): AttentionOption[] {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((option) =>
      option && typeof option.id === 'string'
        ? [
            {
              id: option.id,
              label: typeof option.label === 'string' ? option.label : null,
              description: typeof option.description === 'string' ? option.description : null,
            },
          ]
        : [],
    );
  } catch {
    return [];
  }
}

function parseLabels(text: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).flatMap(([key, value]) =>
        typeof value === 'string' ? [[key, value]] : [],
      ),
    );
  } catch {
    return {};
  }
}

/** The items, longest-waiting first, then by run. */
export function attentionItems<Row extends AttentionRow>(
  rows: readonly Row[],
): (Omit<Row, 'options' | 'labels'> & Pick<AttentionItem, 'options' | 'labels'>)[] {
  return rows
    .map((row) => ({ ...row, options: parseChoices(row.options), labels: parseLabels(row.labels) }))
    .sort(
      (a, b) =>
        a.waiting_since.getTime() - b.waiting_since.getTime() || a.run_id.localeCompare(b.run_id),
    );
}

const paragraphs = (message: string) =>
  message
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph !== '');

const plain = (text: string) => text.replace(/\*\*/g, '').replace(/`/g, '').trim();

const WHAT_IT_IS = '**What it is.**';

/** The message's first line when it is wholly bold, such as `**Build queue, issue 15: scope decision**`. */
export function attentionTitle(message: string): string | null {
  const first = message.trim().split('\n')[0]?.trim() ?? '';
  const match = /^\*\*([^*]+)\*\*$/.exec(first);
  return match?.[1]?.trim() ?? null;
}

/**
 * The question in plain words: the "What it is." paragraph without its lead, else the first
 * paragraph that is not the title, else the whole message.
 */
export function attentionQuestion(message: string): string {
  const all = paragraphs(message);
  const what = all.find((paragraph) => paragraph.startsWith(WHAT_IT_IS));
  if (what) return plain(what.slice(WHAT_IT_IS.length));
  const title = attentionTitle(message);
  const body = all.find((paragraph) => !(title !== null && paragraph === `**${title}**`));
  return plain(body ?? message);
}

/**
 * The pack's `**Recommendation: `<id>`** (<word> confidence). <why>` line, read as migration
 * 0031's projector reads it: the choice from the first lead anywhere in the message, the
 * confidence from the first lead followed by one lowercase word and " confidence" (not
 * necessarily the same lead). db/projection.test.ts holds the two to the same messages.
 */
const RECOMMENDATION = /\*\*Recommendation: `([^`]+)`\*\*(?: \([a-z]+ confidence\))?/;
const CONFIDENCE = /\*\*Recommendation: `[^`]+`\*\* \(([a-z]+) confidence\)/;

/** The message's Recommendation line, the fallback for a wait with no structured `recommendation`: its choice, its confidence word, and its reason (the rest of its paragraph). */
export function parseRecommendation(
  message: string,
): { choice: string; confidence: string | null; reason: string } | null {
  const match = RECOMMENDATION.exec(message);
  if (match === null) return null;
  const rest = message.slice(match.index + match[0].length).split(/\n\s*\n/)[0] ?? '';
  return {
    choice: match[1] ?? '',
    confidence: CONFIDENCE.exec(message)?.[1] ?? null,
    reason: plain(rest.replace(/^\./, '')),
  };
}

/** The reason the Recommendation line gives: the rest of its paragraph after the choice and its confidence; '' when none. */
export function recommendationReason(message: string): string {
  return parseRecommendation(message)?.reason ?? '';
}

/**
 * Where the item came from: its labels as `key: value` joined by ` · `, a label with no value as
 * just its key; without labels, the workflow's name without its `archon-` lead.
 */
export function attentionOrigin(item: Pick<AttentionItem, 'labels' | 'workflow_name'>): string {
  const labels = Object.entries(item.labels).map(([key, value]) =>
    value === '' ? key : `${key}: ${value}`,
  );
  return labels.length > 0 ? labels.join(' · ') : item.workflow_name.replace(/^archon-/, '');
}
